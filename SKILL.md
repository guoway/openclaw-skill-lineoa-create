# LINE OA 客服機器人建置 SKILL

## 概述

這個 SKILL 用於在 OpenClaw 環境下建置一個完整的 LINE Official Account (OA) 客服機器人，具備以下功能：

- **自動回覆**：根據 RAG 知識庫自動回覆客戶問題
- **語氣模仿**：學習 Owner 的回覆風格
- **知識庫檢索**：使用 BGE-m3 向量檢索 + Qdrant
- **智能問答**：使用 Gemini LLM 生成回覆
- **SSL 自動化**：Let's Encrypt 自動簽章

---

## 目錄結構

```
lineoa-create/
├── SKILL.md                          # 主 SKILL 說明文件
├── README.md                         # 專案說明
├── lineoa-create.skill               # SKILL 定義檔
├── assets/                           # 主要資產
│   └── .env.example                  # 環境變數範本
├── scripts/                          # 部署腳本
│   └── deploy.sh                     # 主要部署腳本
├── references/                       # 參考文件
│   └── ...
└── skills/                           # 子 SKILL 目錄
    └── line-webhook-deploy/          # Webhook 部署子 SKILL
        ├── SKILL.md                  # 子 SKILL 說明
        ├── assets/
        │   └── line-webhook-template/  # Webhook 範本
        ├── references/
        │   ├── providers.md          # LLM 提供者設定
        │   ├── schema.md             # 資料庫 Schema
        │   └── troubleshooting.md    # 故障排除
        └── scripts/
            └── deploy.sh             # 子 SKILL 部署腳本
```

---

## 子 SKILL 說明

### line-webhook-deploy
負責部署 LINE Webhook 服務，包含：
- Express webhook server
- MySQL 資料庫（對話記錄）
- Qdrant 向量資料庫（RAG）
- 自動檔案索引服務
- nginx-proxy + Let's Encrypt SSL

**使用情境**：當需要為客戶部署 LINE Bot 後端服務時

**詳細說明**：請參考 [skills/line-webhook-deploy/SKILL.md](skills/line-webhook-deploy/SKILL.md)

---

## 系統架構

```
┌─────────────────┐
│  LINE Platform  │
└────────┬────────┘
         │ Webhook
┌────────▼────────┐
│  nginx-proxy    │ (SSL)
│  :443           │
└────────┬────────┘
         │
┌────────▼────────┐
│  LINE Webhook   │ :3000
│  - RAG 檢索      │
│  - 語氣模仿      │
│  - 自動回覆      │
└────────┬────────┘
         │
    ┌────┴────┬──────────┐
    ▼         ▼          ▼
┌───────┐ ┌───────┐ ┌──────────┐
│ Qdrant│ │ MySQL │ │ Ollama   │
│ 向量DB│ │ 對話記錄│ │ BGE-m3   │
└───────┘ └───────┘ └──────────┘
                           │
                    ┌──────▼──────┐
                    │ GPU Server  │
                    │ (另一台主機) │
                    └─────────────┘
```

---

## 前置需求

### 1. 硬體需求

**Webhook Server（本機）**：
- CPU: 4 核心以上
- RAM: 8GB 以上
- Disk: 50GB 以上

**GPU Server（另一台主機，用於 BGE-m3）**：
- CPU: 8 核心以上
- RAM: 32GB 以上
- GPU: NVIDIA GTX 1070 或以上（8GB VRAM）

### 2. 軟體需求

- Docker & Docker Compose
- Git
- curl
- 域名（用於 SSL）

### 3. API Keys

- LINE Channel Access Token
- LINE Channel Secret
- Google Gemini API Key
- （可選）OpenAI API Key

---

## 快速開始

### 步驟 1：準備環境

```bash
# 進入 OpenClaw skills 目錄
cd ~/.openclaw/workspace-test/skills

# Clone SKILL（如果還沒有）
#（或在 OpenClaw 中使用 SKILL 指令）
```

### 步驟 2：從範本建立客戶專案

```bash
# 複製 webhook 範本到客戶目錄
cp -r skills/lineoa-create/skills/line-webhook-deploy/assets/line-webhook-template ./customer-name

# 進入客戶專案目錄
cd customer-name
```

### 步驟 3：設定環境變數

```bash
# 複製範本
cp .env.example .env

# 編輯設定
nano .env
```

**必填欄位**：
```bash
# 域名
DOMAIN=your-domain.com

# LINE Bot
LINE_CHANNEL_ACCESS_TOKEN=your_token
LINE_CHANNEL_SECRET=your_secret

# Owner User ID
OWNER_USER_IDS=your_line_user_id

# Gemini API
OPENAI_API_KEY=your_gemini_api_key
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash

# BGE-m3（GPU Server）
USE_OLLAMA_EMBEDDINGS=true
OLLAMA_API_URL=http://your-gpu-server:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
```

### 步驟 4：部署 GPU Server（BGE-m3）

**在 GPU Server 上執行**：

```bash
# 安裝 Docker
curl -fsSL https://get.docker.com | sh

# 安裝 NVIDIA Container Toolkit
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker

# 啟動 Ollama + BGE-m3
docker run -d \
  --name ollama \
  --gpus all \
  -p 11434:11434 \
  -v ollama-data:/root/.ollama \
  ollama/ollama

# 下載 BGE-m3 模型
docker exec ollama ollama pull bge-m3
```

### 步驟 5：啟動服務

```bash
# 建立 knowledge 目錄
mkdir -p knowledge

# 啟動所有服務
docker compose up -d

# 查看日誌
docker compose logs -f webhook
```

### 步驟 6：驗證部署

```bash
# 檢查服務狀態
docker compose ps

# 檢查 Qdrant
curl http://localhost:6333/collections/knowledge_base

# 檢查 Webhook
curl https://your-domain.com/health
```

---

## 知識庫管理

### 加入檔案到知識庫

```bash
# 將檔案放入 knowledge 目錄
cp your-documents/* knowledge/

# Indexer 會自動索引新檔案
# 或手動觸發
docker compose restart indexer
```

### 支援的檔案格式

- PDF (.pdf)
- Word (.docx, .doc)
- Excel (.xlsx, .xls)
- 文字 (.txt, .md)

### 從 Google Drive 同步

```bash
# 使用 local-gdrive SKILL
# 參考：skills/local-gdrive/SKILL.md
```

---

## 功能說明

### 1. 智能自動回覆（情境感知）

**群組/聊天室**：
- 只在被 `@提及` 時回覆（避免打擾群組對話）
- 支援格式：`@席爾克軟體`、`@席爾克`、`@bot`、`@客服`

**1-on-1 對話**：
- `/auto` - 開啟自動回覆（預設）
- `/manual` - 關閉自動回覆，改由人工處理
- `/status` - 查詢目前模式

**通用指令**：
- `/help` - 顯示使用說明（所有人可用）

### 2. 語氣模仿

系統會分析 Owner 的回覆風格，並模仿其語氣：
- 平均句長
- 常用語
- 正式程度
- 標點風格

### 3. RAG 檢索

- **向量檢索**：BGE-m3（1024 維）
- **資料庫**：Qdrant
- **候選數**：100 筆
- **Reranking**：關鍵詞加權

### 4. LLM 生成

- **模型**：Gemini 2.5 Flash / 3 Flash Preview
- **角色**：業務人員向客戶解釋
- **溫度**：0.7

---

## 維護操作

### 查看日誌

```bash
# Webhook 日誌
docker compose logs -f webhook

# Indexer 日誌
docker compose logs -f indexer

# 所有服務日誌
docker compose logs -f
```

### 重新索引

```bash
# 清空向量資料庫
curl -X DELETE http://localhost:6333/collections/knowledge_base

# 重新啟動 indexer
docker compose restart indexer
```

### 更新模型

```bash
# 更新 LLM 模型（修改 .env 中的 LLM_MODEL）
# 例如：gemini-2.5-flash → gemini-3-flash-preview
nano .env
docker compose up -d --force-recreate webhook
```

---

## 故障排除

### Webhook 無法啟動

```bash
# 檢查環境變數
docker exec line-webhook printenv | grep -E "LINE|OPENAI|OLLAMA"

# 檢查日誌
docker compose logs webhook | grep -i error
```

### RAG 檢索無結果

```bash
# 檢查 Qdrant 狀態
curl http://localhost:6333/collections/knowledge_base

# 檢查向量數量
curl http://localhost:6333/collections/knowledge_base | jq '.result.points_count'
```

### BGE-m3 連線失敗

```bash
# 測試 GPU Server 連線
curl http://your-gpu-server:11434/api/embed \
  -H "Content-Type: application/json" \
  -d '{"model": "bge-m3", "input": "測試"}'

# 檢查 GPU Server 日誌
docker logs ollama
```

---

## 進階設定

### 自訂 Reranking 規則

編輯 `skills/line-webhook-deploy/assets/line-webhook-template/webhook/src/rag.js`：

```javascript
// 關鍵詞加權規則
if (queryText.includes('報價原則') && source.includes('報價原則')) {
    boostedScore += 1.0;
}
```

### 自訂 System Prompt

編輯 `skills/line-webhook-deploy/assets/line-webhook-template/webhook/src/llm.js`：

```javascript
{
    role: 'system',
    content: `你是席爾克軟體的專業業務人員...`
}
```

### 調整檢索參數

編輯 `skills/line-webhook-deploy/assets/line-webhook-template/webhook/src/rag.js`：

```javascript
const candidateLimit = 100;  // 候選數量
const limit = 5;             // 返回數量
```

---

## 成本估算

| 項目 | 成本 |
|------|------|
| BGE-m3（本地 GPU）| 免費 |
| Gemini 2.5 Flash | ~$0.01/1000 次查詢 |
| Gemini Embedding | 已棄用 |
| SSL 憑證 | 免費（Let's Encrypt）|
| **總計** | **< $1/月** |

---

## 安全性建議

1. **限制 Qdrant 存取**：只允許內部網路存取
2. **API Key 保護**：不要將 `.env` 加入 git
3. **SSL 強制**：所有流量都走 HTTPS
4. **定期備份**：備份 MySQL 和 Qdrant 資料

---

## 授權

MIT License

---

## 更新日誌

### v1.1.0 (2026-03-03)
- 重組目錄結構，加入子 SKILL 支援
- 新增 `skills/line-webhook-deploy` 子 SKILL
- 更新自動回覆行為：
  - 群組：只在 @提及 時回覆
  - 1-on-1：支援 auto/manual 模式切換
- 新增 `/help` 指令（所有人可用）

### v1.0.0 (2026-02-25)
- 初始版本
- 支援 BGE-m3 + Gemini 2.5 Flash
- RAG 知識庫檢索
- 語氣模仿功能
- 自動 SSL

---

## 聯繫方式

- 作者：Ken Chen
- Email：ken@sylksoft.com
- GitHub：https://github.com/your-repo/lineoa-create
