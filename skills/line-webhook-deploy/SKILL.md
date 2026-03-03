---
name: line-webhook-deploy
description: Deploy a complete LINE Official Account Webhook system with RAG (Retrieval-Augmented Generation), conversation logging, and owner style learning. Use when setting up LINE Bot infrastructure that needs (1) webhook endpoint to receive LINE events, (2) MySQL database for conversation storage, (3) Qdrant vector database for document retrieval, (4) smart auto-reply (groups: @mention only; 1-on-1: auto/manual mode), (5) owner speaking style imitation based on conversation history. Supports any OpenAI-compatible LLM (Moonshot, Zaiku, Gemini, OpenRouter, etc.).
---

# LINE Webhook Deploy

Deploy a production-ready LINE OA Webhook system with RAG capabilities.

## Quick Start

```bash
# 1. Copy the template to target directory
cp -r assets/line-webhook-template ./my-line-bot

# 2. Configure environment variables
cp my-line-bot/.env.example my-line-bot/.env
# Edit .env with your credentials

# 3. Deploy
cd my-line-bot && docker-compose up -d
```

## Architecture

```
LINE Platform ──HTTPS──→ nginx-proxy (SSL) ──HTTP──→ webhook (Node.js)
                                   │                         │
                    ┌──────────────┼─────────────────────────┤
                    │              │                         │
               Let's Encrypt    MySQL                    Qdrant
               (acme-companion) (conversation)        (vector search)
                                                        │
                                                    indexer
                                                (file watcher)
```

## Components

| Service | Purpose | Port |
|---------|---------|------|
| webhook | Express server handling LINE events | 3000 (internal) |
| nginx-proxy | Reverse proxy with auto SSL | 80, 443 |
| acme-companion | Let's Encrypt certificate automation | - |
| mysql | Conversation & user data | 13306 (host) |
| qdrant | Vector database for RAG | 6333 (internal) |
| indexer | Auto-index files from knowledge/ | - |

## Required Credentials

### LINE Developers Console
- Channel Access Token
- Channel Secret
- Owner User IDs (obtained after first interaction)

### Domain & SSL
- A domain name pointing to your server
- Let's Encrypt will auto-generate SSL certificates

### LLM Provider (OpenAI-compatible)
- API Key
- Base URL (provider-specific)
- Model name

See [references/providers.md](references/providers.md) for LLM provider configurations.

## Key Features

### 1. Conversation Logging
All messages stored in `t_messages` table with `is_owner` flag for style learning.

### 2. Smart Auto-Reply (情境感知)

**群組/聊天室：**
- 只在被 `@提及` 時回覆（避免打擾群組對話）
- 支援格式：`@席爾克軟體`、`@席爾克`、`@bot`、`@客服`
- 也支援 LINE 原生的 @提及 功能

**1-on-1 對話：**
- `/auto` - 開啟自動回覆（預設）
- `/manual` - 關閉自動回覆，改由人工處理
- `/status` - 查詢目前模式

**通用指令：**
- `/help` - 顯示使用說明（所有人可用）

### 3. RAG Retrieval
Documents in `knowledge/` are auto-indexed to Qdrant. LLM answers based on retrieved context.

### 4. Style Imitation
Analyze owner's historical messages to mimic speaking style. Trigger via `POST /admin/analyze-style`.

## File Structure

```
line-webhook/
├── docker-compose.yml      # Service orchestration
├── .env.example            # Environment template
├── init.sql                # Database schema
├── ngrok.yml               # Tunnel config
├── webhook/                # Main service
│   ├── src/
│   │   ├── index.js        # Webhook handler & business logic
│   │   ├── db.js           # MySQL connection
│   │   ├── rag.js          # Vector search
│   │   └── llm.js          # LLM integration
│   ├── Dockerfile
│   └── package.json
├── indexer/                # File indexing service
│   ├── indexer.js
│   ├── Dockerfile
│   └── package.json
└── knowledge/              # Document storage
```

## Configuration

### Environment Variables (.env)

```bash
# LINE Bot
LINE_CHANNEL_ACCESS_TOKEN=xxx
LINE_CHANNEL_SECRET=xxx
OWNER_USER_IDS=xxx,yyy        # 支援多個 Owner，逗號分隔

# LLM (Moonshot example)
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.moonshot.cn/v1
LLM_MODEL=moonshot-v1-8k

# Embedding (選一種)
# Ollama (本地)
USE_OLLAMA_EMBEDDINGS=true
OLLAMA_API_URL=http://host.docker.internal:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
# 或 Gemini
USE_GEMINI_EMBEDDINGS=true
EMBEDDING_MODEL=embedding-001
```

### Available Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/help` | 所有人 | 顯示使用說明 |
| `/auto` | Owner | 開啟自動回覆（1-on-1） |
| `/manual` | Owner | 關閉自動回覆（1-on-1） |
| `/status` | Owner | 查詢目前模式 |

## Deployment Steps

1. **Install Docker & Docker Compose**

2. **Create project from template**
   ```bash
   cp -r assets/line-webhook-template ./my-bot
   cd my-bot
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Start services**
   ```bash
   docker compose up -d --build
   ```

5. **Configure LINE Console**
   - Go to https://developers.line.biz/
   - Enable webhook, set URL to `https://your-domain.com/webhook`
   - Verify the webhook works

6. **Identify Owner User ID**
   - Send a message to the bot
   - Check MySQL: `SELECT user_id, display_name FROM t_users`
   - Update `.env` with `OWNER_USER_IDS`
   - Restart: `docker compose restart webhook`

7. **Add knowledge documents**
   - Copy PDF/DOCX/TXT/MD files to `knowledge/`
   - Indexer auto-processes within seconds

8. **(Optional) Analyze owner style**
   ```bash
   curl -X POST http://localhost:3000/admin/analyze-style
   ```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| /webhook | POST | LINE webhook endpoint |
| /health | GET | Health check |
| /stats | GET | Message/user statistics |
| /admin/analyze-style | POST | Trigger owner style analysis |

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for common issues.

## Database Schema

See [references/schema.md](references/schema.md) for complete table definitions.

## LLM Provider Examples

See [references/providers.md](references/providers.md) for configuration examples of:
- Moonshot AI
- Zaiku
- Google Gemini
- OpenAI
- OpenRouter
- Local models (Ollama)
