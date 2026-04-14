---
name: line-webhook-deploy
description: Deploy a complete LINE Official Account Webhook system with RAG (Retrieval-Augmented Generation), conversation logging, and owner style learning. Use when setting up LINE Bot infrastructure that needs (1) webhook endpoint to receive LINE events, (2) MySQL database for conversation storage, (3) Qdrant vector database for document retrieval, (4) smart auto-reply (groups: @mention only; 1-on-1: auto/manual mode), (5) owner speaking style imitation based on conversation history. Supports any OpenAI-compatible LLM (Moonshot, Zaiku, Gemini, OpenRouter, etc.).
---

# LINE Webhook Deploy

Deploy a production-ready LINE OA Webhook system with RAG capabilities.  
**技術棧：Python 3.12 + FastAPI（非 Node.js 版本）**

## Quick Start

```bash
# 1. Copy the template to target directory
cp -r assets/line-webhook-template ./my-line-bot

# 2. Configure environment variables
cp my-line-bot/.env.example my-line-bot/.env
# Edit .env with your credentials

# 3. Deploy
cd my-line-bot && docker-compose up -d --build
```

## Architecture

```
LINE Platform ──HTTPS──→ nginx-proxy (SSL) ──HTTP──→ webhook-python (FastAPI :3000)
                                   │                         │
                    ┌──────────────┼─────────────────────────┤
                    │              │                         │
               Let's Encrypt    MySQL                    Qdrant
               (acme-companion) (conversation)        (vector search)
                                                        │
                                               indexer-python
                                               (file watcher)
```

## Components

| Service | Purpose | Port |
|---------|---------|------|
| webhook-python | FastAPI server handling LINE events + auto-reply decision | 3000 (internal) |
| nginx-proxy | Reverse proxy with auto SSL（外部對外時啟用） | 80, 443 |
| acme-companion | Let's Encrypt certificate automation | - |
| mysql | Conversation & user data + settings | 13306 (host) |
| qdrant | Vector database for RAG | 6333 (internal) |
| indexer-python | Auto-index files from knowledge/ to Qdrant | - |

## Required Credentials

### LINE Developers Console
- Channel Access Token
- Channel Secret
- Owner User IDs（首次互動後從 MySQL t_users 取得）

### Domain & SSL
- 一個域名指向你的 server
- Let's Encrypt 會自動產生 SSL 憑證（搭配 nginx-proxy + acme-companion）

### LLM Provider（OpenAI-compatible）
- API Key
- Base URL（ provider-specific）
- Model name

See [references/providers.md](references/providers.md) for LLM provider configurations.

## Key Features

### 1. Conversation Logging
All messages stored in `t_messages` table with `is_owner` flag for style learning.

### 2. Smart Auto-Reply（情境感知）

**自動回覆受 `t_settings.auto_reply_enabled` 控制**（預設 `true`）。  
設為 `false` 時，Bot 完全不會主動回覆任何訊息，可用於維護或緊急關閉。

**群組/聊天室：**
- 只在被 `@提及` 時回覆（避免打擾群組對話）
- 支援格式：
  - `@席爾克軟體`（完整名稱）
  - `@席爾克`（簡稱）
  - `@bot`（通用，方便客戶使用）
  - `@客服`（功能稱呼）
- 也支援 LINE 原生的 @提及 功能

**1-on-1 對話：**
- `/auto` - 開啟自動回覆（預設）
- `/manual` - 關閉自動回覆，改由人工處理
- `/status` - 查詢目前模式 + 待審核數

**AI 干預時機邏輯（`owner_response_timeout`，預設 5 分鐘）：**

當一般 user 傳訊息進來時，系統依序檢查：

1. 是否為 Owner 本人？→ 否則繼續
2. 群組但未 mention Bot？→ 不回
3. chat mode 是 `manual`？→ 不回
4. **Owner 在最近 N 分鐘內有回覆過？（`owner_response_timeout`）**→ 回就不打擾
5. 訊息是否命中關鍵字（`AUTO_REPLY_KEYWORDS`）？
6. 以上皆非 → 仍會回覆（啗主動模式）

`owner_response_timeout` 的設計目的：Owner 剛回覆過代表正在處理，AI 不要搶先插話。超過設定時間 Owner 沉默，AI 才補位回覆。

**觸發後流程：**
```
RAG 相似度檢索（Qdrant）
  → 讀取 conversation history（t_messages）
  → 讀取 user memory（t_user_memory）
  → 讀取 owner style（t_owner_style）
  → 讀取 learned knowledge（t_learned_knowledge, status=approved）
  → LLM 生成回覆
```

### 3. Three-Layer Memory System（三層記憶系統）

**第 1 層：短期對話上下文**
- 自動帶入最近 10 輪對話 + 30 分鐘時間窗口
- 讓 Bot 在同一輪對話中記得前面說過的話

**第 2 層：用戶記憶摘要**
- 每個用戶一份長期記憶，對話結束後自動用 LLM 產生摘要
- 記錄用戶關心的主題、偏好、互動次數、狀態

**第 3 層：長期知識庫 + Bot 學習建議**
- 通用知識放在 `knowledge/shared/`，客戶專屬知識放在 `knowledge/{customer}/`
- Bot 偵測到 Owner 手動修正時，自動產生學習建議（待 Owner 審核）

### 4. RAG Retrieval
Documents in `knowledge/` are auto-indexed to Qdrant. LLM answers based on retrieved context.

### 5. Style Imitation
Analyze owner's historical messages to mimic speaking style. Trigger via `POST /admin/analyze-style`.

## File Structure

```
line-webhook/                          # ← 這就是 docker-compose.yml 的 build context（context: ./webhook）
├── docker-compose.yml                 # Service orchestration（本檔案位於此，目錄結尾）
├── Dockerfile
├── requirements.txt
├── app/                               # Python FastAPI 應用程式
│   ├── main.py                        # FastAPI 入口
│   ├── api/
│   │   ├── webhook.py                 # LINE webhook endpoint
│   │   └── admin.py                   # 管理 API（/stats, /analyze-style）
│   ├── core/
│   │   └── config.py                  # 環境變數設定（pydantic_settings）
│   ├── db/
│   │   ├── models/                    # SQLAlchemy models
│   │   └── session.py                  # DB session 管理
│   ├── repositories/                   # 資料存取層
│   ├── services/
│   │   ├── webhook_service.py          # Webhook 主流程
│   │   ├── auto_reply_service.py       # 自動回覆決策邏輯
│   │   ├── rag_service.py             # Qdrant 檢索
│   │   ├── llm_service.py             # LLM 生成
│   │   ├── memory_service.py          # 三層記憶系統
│   │   └── owner_config_service.py    # Owner 設定管理
│   ├── schemas/                       # Pydantic schemas
│   └── scripts/
│       ├── run_indexer.py             # Indexer 入口
│       └── run_memory_jobs.py         # Background memory jobs
├── init.sql                           # 資料庫 schema（含 t_settings 初始資料）
├── knowledge/                         # 文件知識庫
│   ├── shared/
│   └── {customer}/
└── indexer/                           # （已整合至 app/scripts/）
```

> **重要：** `docker-compose.yml` 本身位於 `webhook/` 目錄內，設定 `context: ./webhook`（即 context 為上層目錄）。  
> 這個設計讓 `COPY . ./` 可以正確把 `app/` 等所有原始碼複製進容器。

## t_settings 關鍵設定

系統啟動時，`init.sql` 會寫入以下設定，之後可透過 SQL 或重啟服務後生效：

| setting_key | 預設值 | 說明 |
|------------|--------|------|
| `owner_user_ids` | （空）| Owner 的 LINE user ID，逗號分隔 |
| `auto_reply_enabled` | `true` | 全域自動回覆總開關。`false` 時 Bot 完全不回覆 |
| `owner_response_timeout` | `5` | Owner 多久未回覆才讓 AI 介入（分鐘）|
| `system_prompt` | （預設 prompt）| LLM 系統提示詞 |

**`auto_reply_enabled` 實作邏輯：**
- 放在 `webhook_service.py` 的 `_is_auto_reply_enabled()` 方法
- 在所有 auto-reply 決策之前，獨立 gate 在 `t_settings` 讀取
- `false` 時直接回傳 `reason="auto_reply_disabled"`，不進入 RAG/LLM 流程
- `true/1/yes`（大小寫無關）→ 視為啟用；其餘值 → 預設停用（保險策略）

**`owner_response_timeout` 實作邏輯：**
- 放在 `auto_reply_decision_service.py`
- 每次收到 user 訊息時，查 `t_messages` 確認同 chat 裡 Owner 最近 N 分鐘內是否有回覆
- `has_owner_replied_since(chat_id, timeout_minutes)` → 回 `True` 時，AI 不介入

## Configuration

### Environment Variables (.env)

```bash
# LINE Bot
LINE_CHANNEL_ACCESS_TOKEN=xxx
LINE_CHANNEL_SECRET=xxx
OWNER_USER_IDS=xxx,yyy        # 支援多個 Owner，逗號分隔

# LLM (Gemini example)
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash

# Embedding（選一種）
# Ollama（本地 GPU）
USE_OLLAMA_EMBEDDINGS=true
OLLAMA_API_URL=http://host.docker.internal:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
# 或 Gemini
USE_GEMINI_EMBEDDINGS=true
EMBEDDING_MODEL=embedding-001

# 可選：內部 API 安全 token
INTERNAL_API_TOKEN=your-secret-token
```

### Available Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/help` | 所有人 | 顯示使用說明 |
| `/auto` | Owner | 開啟自動回覆（1-on-1） |
| `/manual` | Owner | 關閉自動回覆（1-on-1） |
| `/status` | Owner | 查詢目前模式 + 待審核數 |
| `/review` | Owner | 審核 Bot 學習建議 |
| `/approve {id}` | Owner | 通過學習建議 |
| `/reject {id} {原因}` | Owner | 拒絕學習建議 |
| `/teach {內容}` | Owner | 主動教 Bot 新知識 |
| `/memory` | Owner | 查看用戶記憶摘要 |
| `/forget {userId}` | Owner | 清除特定用戶記憶 |
| `/reload-owner` | Owner | 重新載入 t_settings.owner_user_ids |
| `/set-owner <id1,id2>` | Owner | 更新 Owner 名單 |

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
   docker-compose up -d --build
   ```

5. **Configure LINE Console**
   - Go to https://developers.line.biz/
   - Enable webhook, set URL to `https://your-domain.com/webhook`
   - Verify the webhook works

6. **Identify Owner User ID**
   - Send a message to the bot
   - Check MySQL: `SELECT user_id, display_name FROM t_users WHERE is_owner=1`
   - Update `.env` with `OWNER_USER_IDS`
   - 重啟 webhook：`docker-compose restart webhook-python`

7. **Add knowledge documents**
   - Copy PDF/DOCX/TXT/MD files to `knowledge/`
   - Indexer auto-processes within seconds

8. **Verify auto-reply settings**
   - 預設 `auto_reply_enabled=true`，`owner_response_timeout=5`（分鐘）
   - 可直接修改 MySQL `t_settings` 調整，或等待系統下次載入

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| /webhook | POST | LINE webhook endpoint |
| /health | GET | Health check（資料庫 + Qdrant 連線狀態）|
| /stats | GET | Message/user statistics（需 INTERNAL_API_TOKEN）|
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
