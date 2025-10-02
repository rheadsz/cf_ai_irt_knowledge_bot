# cf_ai_irt_knowledge_bot

An AI-powered knowledge bot built on Cloudflare's serverless platform that helps users find answers to IRT (Information Resources & Technology) documentation questions using RAG (Retrieval-Augmented Generation).

## 🚀 Live Demo

**Try it now:** [https://irt-bot.rheabdsouza.workers.dev](https://irt-bot.rheabdsouza.workers.dev)

## 📋 Features

- **AI-Powered Q&A**: Uses Llama 3.3 70B for intelligent, context-aware responses
- **Semantic Search**: Vector embeddings with Cloudflare Vectorize for accurate document retrieval
- **Real-time Chat UI**: Clean, responsive web interface
- **Document Ingestion**: Easy API to add new documentation
- **Serverless Architecture**: Fully deployed on Cloudflare's edge network

## 🏗️ Architecture

This application demonstrates all required components:

1. **LLM**: Llama 3.3 70B (Workers AI) for answer generation
2. **Workflow/Coordination**: Cloudflare Workers + Durable Objects
3. **User Input**: Web-based chat interface
4. **Memory/State**: 
   - Vectorize for semantic search (embeddings)
   - KV for chunk text storage
   - Durable Objects for stateful operations

### Tech Stack

- **Runtime**: Cloudflare Workers
- **LLM**: Workers AI (Llama 3.3 70B)
- **Embeddings**: Workers AI (BGE Large EN v1.5)
- **Vector Database**: Cloudflare Vectorize
- **Storage**: Cloudflare KV
- **State Management**: Durable Objects
- **Frontend**: Vanilla JavaScript with modern CSS

## 🛠️ Setup & Installation

### Prerequisites

- Node.js 16+
- Cloudflare account
- Wrangler CLI

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/cf_ai_irt_knowledge_bot.git
   cd cf_ai_irt_knowledge_bot
   ```

2. **Install dependencies**
   ```bash
   npm install -g wrangler
   ```

3. **Login to Cloudflare**
   ```bash
   wrangler login
   ```

4. **Create Vectorize index**
   ```bash
   wrangler vectorize create irt_kb --dimensions=1024 --metric=cosine
   ```

5. **Create KV namespace**
   ```bash
   wrangler kv namespace create CHUNKS
   ```
   
   Update `wrangler.jsonc` with the KV namespace ID.

6. **Set up environment variables**
   
   Add your Cloudflare Account ID to `wrangler.jsonc`:
   ```json
   "vars": {
     "CLOUDFLARE_ACCOUNT_ID": "your-account-id"
   }
   ```

7. **Create API token** (for Vectorize REST API)
   
   Go to Cloudflare Dashboard → API Tokens → Create Token
   - Permission: Account → Vectorize → Edit
   
   Then set it as a secret:
   ```bash
   wrangler secret put CLOUDFLARE_API_TOKEN
   ```

8. **Run locally**
   ```bash
   wrangler dev
   ```
   
   Visit `http://localhost:8787` to see the chat interface.

## 📤 Deploying to Production

```bash
wrangler deploy
```

Your bot will be live at `https://your-worker-name.workers.dev`

## 📚 Ingesting Documents

To add documents to the knowledge base:

```bash
curl -X POST https://irt-bot.rheabdsouza.workers.dev/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "id": "document-id",
    "title": "Document Title",
    "text": "Your document content here..."
  }'
```

### Batch Ingestion

Use the provided script to ingest multiple documents:

```bash
./reingest.sh
```

This will process all `.txt` files in the `pdfs_txt/` directory.

## 🔧 API Endpoints

### `POST /ask`
Ask a question and get an AI-generated answer.

**Request:**
```json
{
  "question": "How do I log into WCM?"
}
```

**Response:**
```json
{
  "answer": "To log into the WCM:\n1. Navigate to https://csus.cascadecms.com/\n2. Log in with your Sac State username and password..."
}
```

### `POST /ingest`
Add a new document to the knowledge base.

**Request:**
```json
{
  "id": "doc-id",
  "title": "Document Title",
  "text": "Document content..."
}
```

**Response:**
```json
{
  "inserted": 5
}
```

### `GET /`
Serves the chat UI.

## 🧪 Testing

Test the AI endpoint:
```bash
curl -X POST https://irt-bot.rheabdsouza.workers.dev/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I embed images in WCM?"}'
```

## 🎨 Customization

### Adjusting Response Length

Edit `src/index.ts`:
```typescript
max_tokens: 300  // Increase for longer responses
```

### Changing Temperature

```typescript
temperature: 0.1  // Lower = more focused, Higher = more creative
```

### Modifying Chunk Size

```typescript
function chunkText(text: string, target = 1200, overlap = 200)
```

## 📁 Project Structure

```
cf_ai_irt_knowledge_bot/
├── src/
│   └── index.ts           # Main Worker code
├── pdfs_txt/              # Source documents
│   ├── how-to-login.txt
│   ├── embedding-images.txt
│   └── content-bar.txt
├── wrangler.jsonc         # Cloudflare configuration
├── reingest.sh            # Batch ingestion script
├── extract_pdfs.py        # PDF extraction utility
└── README.md
```

## 🐛 Troubleshooting

### Vectorize binding errors
The project uses the Vectorize REST API instead of the binding due to serialization issues. Make sure `CLOUDFLARE_API_TOKEN` is set.

### Empty responses
Ensure documents are properly ingested and the Vectorize index is populated:
```bash
curl -X POST http://localhost:8787/ingest -H "Content-Type: application/json" -d @your-doc.json
```

### CORS errors
CORS headers are already configured in the Worker. If issues persist, check your domain configuration.

## 🤝 Contributing

This is a submission project for Cloudflare's AI assignment. Feel free to fork and adapt for your own use cases!

## 📝 License

MIT License - feel free to use this project as a template for your own AI-powered applications.

## 🙏 Acknowledgments

- Built with Cloudflare Workers AI
- Uses Llama 3.3 70B for text generation
- BGE Large EN v1.5 for embeddings
- Inspired by modern RAG architectures

---

**Built by Rhea Dsouza** | [Live Demo](https://irt-bot.rheabdsouza.workers.dev)
