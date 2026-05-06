# Pinecone Document Agent

This project provides a simple AI agent that:
- reads files from `docs/`
- supports `.pdf` and `.docx` files
- chunks document text
- creates embeddings with Pinecone Inference
- stores vectors in your Pinecone index
- lets you run semantic queries over ingested content
- exposes a local REST API for upload + ingest + query
- includes retry with exponential backoff and structured logging
- includes a local dashboard with drag-and-drop upload, query results, and file analytics

## 1) Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
copy .env.example .env
```

3. Open `.env` and set values:

```env
PINECONE_API_KEY=your_pinecone_api_key_here
PINECONE_INDEX=your_index_name_here
PINECONE_NAMESPACE=default
EMBEDDING_MODEL=multilingual-e5-large
DOCS_DIR=./docs
TOP_K=5
PORT=3000
MAX_UPLOAD_MB=10
RETRY_ATTEMPTS=3
RETRY_BASE_DELAY_MS=500
```

## 2) Add Documents

Place your documents in the `docs/` folder. Supported file types:
- `.txt`
- `.md`
- `.json`
- `.csv`
- `.log`
- `.pdf`
- `.docx`

## 3) Ingest Documents into Pinecone

```bash
npm run ingest
```

## 4) Query Your Vector DB

```bash
npm run query -- "What does the document say about pricing?"
```

## 5) Start Local API Server

```bash
npm run api
```

Local links:
- `http://localhost:3000/health`
- `http://localhost:3000`

### API Endpoints

1. Health check

```bash
curl http://localhost:3000/health
```

2. Ingest from local docs directory

```bash
curl -X POST http://localhost:3000/ingest \
	-H "Content-Type: application/json" \
	-d "{\"docsDir\":\"./docs\"}"
```

3. Upload and ingest files directly

```bash
curl -X POST http://localhost:3000/upload-ingest \
	-F "files=@docs/sample.txt" \
	-F "files=@docs/your-file.pdf"
```

4. Query

```bash
curl -X POST http://localhost:3000/query \
	-H "Content-Type: application/json" \
	-d "{\"text\":\"What is in my uploaded documents?\"}"
```

5. File analytics

```bash
curl "http://localhost:3000/analytics?docsDir=./docs"
```

The dashboard at `http://localhost:3000` now includes:
- drag-and-drop upload
- directory analytics totals
- query results table

## Security Note

Do not hardcode API keys in code. Keep your key in `.env` only, and rotate keys that were shared in chat or public places.
