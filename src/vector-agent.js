import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { Pinecone } from '@pinecone-database/pinecone';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import pino from 'pino';

dotenv.config();

export const config = {
  apiKey: process.env.PINECONE_API_KEY,
  indexName: process.env.PINECONE_INDEX,
  namespace: process.env.PINECONE_NAMESPACE || 'default',
  embeddingModel: process.env.EMBEDDING_MODEL || 'multilingual-e5-large',
  docsDir: process.env.DOCS_DIR || './docs',
  topK: Number(process.env.TOP_K || 5),
  chunkSize: Number(process.env.CHUNK_SIZE || 1200),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP || 200),
  retryAttempts: Number(process.env.RETRY_ATTEMPTS || 3),
  retryBaseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS || 500),
};

export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(operationName, action) {
  let lastError;
  for (let attempt = 1; attempt <= config.retryAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < config.retryAttempts;
      logger.warn(
        {
          operationName,
          attempt,
          maxAttempts: config.retryAttempts,
          error: error?.message,
        },
        'Operation failed'
      );

      if (!shouldRetry) break;
      const delay = config.retryBaseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError;
}

export function validateConfig() {
  if (!config.apiKey) {
    throw new Error('Missing PINECONE_API_KEY in environment variables.');
  }
  if (!config.indexName) {
    throw new Error('Missing PINECONE_INDEX in environment variables.');
  }
}

export function chunkText(text, chunkSize = 1200, overlap = 200) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === normalized.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

async function walkFilesRecursively(dir) {
  const dirEntries = await fs.readdir(dir, { withFileTypes: true });
  const filePaths = await Promise.all(
    dirEntries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkFilesRecursively(fullPath);
      return fullPath;
    })
  );
  return filePaths.flat();
}

function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.txt', '.md', '.json', '.csv', '.log', '.pdf', '.docx'].includes(ext);
}

export async function parseDocumentText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (ext === '.pdf') {
    const parsed = await pdfParse(buffer);
    return parsed.text || '';
  }

  if (ext === '.docx') {
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed.value || '';
  }

  return buffer.toString('utf8');
}

async function loadDocuments(docsDir) {
  const fullDir = path.resolve(docsDir);
  const exists = await fs
    .access(fullDir)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    throw new Error(`Docs directory not found: ${fullDir}`);
  }

  const files = (await walkFilesRecursively(fullDir)).filter(isSupportedFile);
  const docs = [];

  for (const filePath of files) {
    const content = await parseDocumentText(filePath);
    docs.push({
      source: path.relative(process.cwd(), filePath),
      content,
    });
  }

  return docs;
}

export async function listSupportedFiles(docsDir) {
  const fullDir = path.resolve(docsDir);
  const exists = await fs
    .access(fullDir)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    throw new Error(`Docs directory not found: ${fullDir}`);
  }

  return (await walkFilesRecursively(fullDir)).filter(isSupportedFile);
}

async function embedTexts(pc, texts, inputType) {
  const result = await withRetry('pinecone.embed', async () => {
    return pc.inference.embed(config.embeddingModel, texts, {
      inputType,
      truncate: 'END',
    });
  });

  if (!result || !Array.isArray(result.data)) {
    throw new Error('Unexpected embedding response from Pinecone.');
  }

  return result.data.map((item) => item.values || item.embedding || []);
}

async function buildRecords(pc, documents) {
  const records = [];

  for (const doc of documents) {
    const chunks = chunkText(doc.content, config.chunkSize, config.chunkOverlap);
    if (chunks.length === 0) continue;

    const embeddings = await embedTexts(pc, chunks, 'passage');

    embeddings.forEach((vector, i) => {
      records.push({
        id: `${doc.source}-${i}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        values: vector,
        metadata: {
          source: doc.source,
          chunkIndex: i,
          text: chunks[i],
        },
      });
    });
  }

  return records;
}

async function upsertRecords(index, records) {
  const batchSize = 100;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await withRetry('pinecone.upsert', async () => {
      await index.upsert(batch);
    });
  }
}

function createClients() {
  validateConfig();

  const pc = new Pinecone({ apiKey: config.apiKey });
  const index = pc.index(config.indexName).namespace(config.namespace);
  return { pc, index };
}

export async function ingestDocuments(documents) {
  const { pc, index } = createClients();

  if (documents.length === 0) {
    logger.info('No supported documents supplied for ingestion.');
    return { upserted: 0, files: 0 };
  }

  const records = await buildRecords(pc, documents);
  if (records.length === 0) {
    logger.info('No chunks generated from supplied documents.');
    return { upserted: 0, files: documents.length };
  }

  await upsertRecords(index, records);
  logger.info({ upserted: records.length, files: documents.length }, 'Ingestion complete');
  return { upserted: records.length, files: documents.length };
}

export async function ingestFromDirectory(docsDir = config.docsDir) {
  const documents = await loadDocuments(docsDir);
  return ingestDocuments(documents);
}

export async function ingest() {
  const result = await ingestFromDirectory(config.docsDir);
  if (result.upserted === 0) {
    console.log('No vectors were upserted.');
    return;
  }

  console.log(`Ingestion complete. Upserted ${result.upserted} vectors from ${result.files} files.`);
}

export async function query(searchText) {
  validateConfig();

  if (!searchText || !searchText.trim()) {
    throw new Error('Please provide a search query text.');
  }

  const pc = new Pinecone({ apiKey: config.apiKey });
  const index = pc.index(config.indexName).namespace(config.namespace);

  const [queryVector] = await embedTexts(pc, [searchText], 'query');
  const result = await withRetry('pinecone.query', async () => {
    return index.query({
      vector: queryVector,
      topK: config.topK,
      includeMetadata: true,
    });
  });

  return result.matches || [];
}

async function main() {
  const command = process.argv[2];

  if (command === 'ingest') {
    await ingest();
    return;
  }

  if (command === 'query') {
    const searchText = process.argv.slice(3).join(' ');
    const matches = await query(searchText);

    if (matches.length === 0) {
      console.log('No matches found.');
      return;
    }

    console.log(`Top ${matches.length} matches:`);
    for (const match of matches) {
      const score = typeof match.score === 'number' ? match.score.toFixed(4) : 'n/a';
      const source = match.metadata?.source || 'unknown';
      const text = match.metadata?.text || '';
      console.log('\n---');
      console.log(`score: ${score}`);
      console.log(`source: ${source}`);
      console.log(`text: ${String(text).slice(0, 280)}`);
    }
    return;
  }

  console.log('Usage:');
  console.log('  npm run ingest');
  console.log('  npm run query -- "your question"');
  console.log('  npm run api');
}

if (process.argv[1] && process.argv[1].endsWith('vector-agent.js')) {
  main().catch((err) => {
    logger.error({ error: err.message }, 'Agent command failed');
    console.error('Error:', err.message);
    process.exitCode = 1;
  });
}
