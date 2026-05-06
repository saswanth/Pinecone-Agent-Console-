import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import express from 'express';
import multer from 'multer';
import pinoHttp from 'pino-http';
import dotenv from 'dotenv';
import {
  chunkText,
  config,
  listSupportedFiles,
  logger,
  ingestDocuments,
  ingestFromDirectory,
  parseDocumentText,
  query,
  validateConfig,
} from './vector-agent.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 10);
const publicDir = path.resolve(process.cwd(), 'public');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadMb * 1024 * 1024 },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          id: req.id,
        };
      },
    },
  })
);

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

function configState() {
  return {
    apiKeyConfigured: Boolean(config.apiKey),
    indexConfigured: Boolean(config.indexName),
    indexName: config.indexName || null,
    namespace: config.namespace,
    embeddingModel: config.embeddingModel,
  };
}

function sanitizeName(fileName = 'uploaded_file') {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function fileStatsFromDisk(filePath, rootDir) {
  const text = await parseDocumentText(filePath);
  const stats = await fs.stat(filePath);
  const chunks = chunkText(text, config.chunkSize, config.chunkOverlap);
  const ext = path.extname(filePath).toLowerCase() || 'unknown';

  return {
    source: path.relative(process.cwd(), filePath),
    relativeToDocs: path.relative(rootDir, filePath),
    extension: ext,
    bytes: stats.size,
    characters: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    estimatedChunks: chunks.length,
  };
}

function fileStatsFromUpload(file, text) {
  const chunks = chunkText(text, config.chunkSize, config.chunkOverlap);
  const ext = path.extname(file.originalname || '').toLowerCase() || 'unknown';

  return {
    source: `upload/${sanitizeName(file.originalname)}`,
    extension: ext,
    bytes: file.size,
    characters: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    estimatedChunks: chunks.length,
  };
}

function summarizeAnalytics(files) {
  const totals = {
    files: files.length,
    bytes: 0,
    characters: 0,
    words: 0,
    estimatedChunks: 0,
  };
  const byType = {};

  for (const file of files) {
    totals.bytes += file.bytes;
    totals.characters += file.characters;
    totals.words += file.words;
    totals.estimatedChunks += file.estimatedChunks;

    if (!byType[file.extension]) {
      byType[file.extension] = { files: 0, bytes: 0, estimatedChunks: 0 };
    }

    byType[file.extension].files += 1;
    byType[file.extension].bytes += file.bytes;
    byType[file.extension].estimatedChunks += file.estimatedChunks;
  }

  return { totals, byType, files };
}

async function buildDirectoryAnalytics(docsDir) {
  const fullDir = path.resolve(docsDir);
  const files = await listSupportedFiles(docsDir);
  const analyticsFiles = await Promise.all(files.map((filePath) => fileStatsFromDisk(filePath, fullDir)));

  return {
    docsDir: fullDir,
    ...summarizeAnalytics(analyticsFiles),
  };
}

app.get('/health', (_req, res) => {
  const cfg = configState();
  const ready = cfg.apiKeyConfigured && cfg.indexConfigured;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'pinecone-doc-agent',
    config: cfg,
  });
});

app.get('/analytics', async (req, res) => {
  try {
    validateConfig();
    const docsDir = String(req.query.docsDir || config.docsDir);
    const analytics = await buildDirectoryAnalytics(docsDir);
    res.json({ ok: true, analytics });
  } catch (error) {
    req.log.error({ error: error.message }, 'Analytics failed');
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/ingest', async (req, res) => {
  try {
    validateConfig();
    const docsDir = req.body?.docsDir || config.docsDir;
    const [result, analytics] = await Promise.all([ingestFromDirectory(docsDir), buildDirectoryAnalytics(docsDir)]);
    res.json({ ok: true, docsDir: path.resolve(docsDir), analytics, ...result });
  } catch (error) {
    req.log.error({ error: error.message }, 'Directory ingestion failed');
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/upload-ingest', upload.array('files', 20), async (req, res) => {
  try {
    validateConfig();

    const files = req.files || [];
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: 'No files uploaded. Use multipart/form-data with field name files.' });
      return;
    }

    const supported = ['.txt', '.md', '.json', '.csv', '.log', '.pdf', '.docx'];
    const docs = [];
    const analyticsFiles = [];

    for (const file of files) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!supported.includes(ext)) {
        continue;
      }

      let content = '';
      if (ext === '.pdf') {
        const pdfParse = (await import('pdf-parse')).default;
        const parsed = await pdfParse(file.buffer);
        content = parsed.text || '';
      } else if (ext === '.docx') {
        const mammoth = (await import('mammoth')).default;
        const parsed = await mammoth.extractRawText({ buffer: file.buffer });
        content = parsed.value || '';
      } else {
        content = file.buffer.toString('utf8');
      }

      docs.push({
        source: `upload/${sanitizeName(file.originalname)}`,
        content,
      });
      analyticsFiles.push(fileStatsFromUpload(file, content));
    }

    const result = await ingestDocuments(docs);
    res.json({
      ok: true,
      uploaded: files.length,
      processed: docs.length,
      analytics: summarizeAnalytics(analyticsFiles),
      ...result,
    });
  } catch (error) {
    req.log.error({ error: error.message }, 'Upload ingestion failed');
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/query', async (req, res) => {
  try {
    validateConfig();
    const text = req.body?.text;
    if (!text || !String(text).trim()) {
      res.status(400).json({ ok: false, error: 'Missing required body field: text' });
      return;
    }

    const matches = await query(String(text));
    res.json({ ok: true, count: matches.length, matches });
  } catch (error) {
    req.log.error({ error: error.message }, 'Query failed');
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.listen(port, () => {
  logger.info({ port }, `Server listening on http://localhost:${port}`);
  const cfg = configState();
  logger.info(cfg, 'Config status');
});
