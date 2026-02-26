# LINE OA 客服機器人建置 SKILL

## 概述

這個 SKILL 用於在 OpenClaw 環境下建置一個完整的 LINE Official Account (OA) 客服機器人。

### 功能特色

- **自動回覆**：根據 RAG 知識庫自動回覆客戶問題
- **語氣模仿**：學習 Owner 的回覆風格
- **知識庫檢索**：使用 BGE-m3 向量檢索 + Qdrant
- **智能問答**：使用 Gemini LLM 生成回覆
- **SSL 自動化**：Let's Encrypt 自動簽章
- **幻覺防護**：嚴格禁止 LLM 捏造資訊

---

## 在 OpenClaw 中使用此 SKILL

### 步驟 1：取得 SKILL

```bash
# 方法 A：從 GitHub Clone
cd ~/.openclaw/workspace-test/skills
git clone https://github.com/your-username/lineoa-create.git

# 方法 B：使用 OpenClaw SKILL 指令（如果有）
# skill install lineoa-create
```

### 步驟 2：準備工作目錄

```bash
# 建立工作目錄
mkdir -p ~/.openclaw/workspace-test/line-webhook
cd ~/.openclaw/workspace-test/line-webhook

# 複製 SKILL 檔案
cp -r ~/.openclaw/workspace-test/skills/lineoa-create/assets/* .
```

### 步驟 3：設定環境變數

```bash
# 複製環境變數範本
cp .env.example .env

# 編輯設定
nano .env
```

**必填欄位**：
```bash
# 域名（需要指向你的伺服器 IP）
DOMAIN=lineoa.yourdomain.com

# LINE Bot 設定（從 LINE Developers Console 取得）
LINE_CHANNEL_ACCESS_TOKEN=your_token_here
LINE_CHANNEL_SECRET=your_secret_here

# Owner User ID（用於語氣模仿）
# 可以從 LINE Developers Console 的 Webhook 測試取得
OWNER_USER_IDS=Uxxxxxxxxxxxxxxxxxxxxxxxxxx

# Gemini API Key
OPENAI_API_KEY=your_gemini_api_key
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash

# BGE-m3 設定（需要另一台 GPU Server）
USE_OLLAMA_EMBEDDINGS=true
OLLAMA_API_URL=http://your-gpu-server:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
```

### 步驟 4：部署 GPU Server（用於 BGE-m3）

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

# 啟動 Ollama
docker run -d \
  --name ollama \
  --gpus all \
  -p 11434:11434 \
  -v ollama-data:/root/.ollama \
  ollama/ollama

# 下載 BGE-m3 模型
docker exec ollama ollama pull bge-m3
```

### 步驟 5：準備知識庫

```bash
# 建立知識庫目錄
mkdir -p knowledge

# 將文件放入知識庫
cp your-documents/*.pdf knowledge/
cp your-documents/*.docx knowledge/
cp your-documents/*.xlsx knowledge/
```

### 步驟 6：啟動服務

```bash
# 啟動所有服務
docker compose up -d

# 查看日誌
docker compose logs -f webhook
```

### 步驟 7：設定 LINE Webhook

1. 前往 [LINE Developers Console](https://developers.line.biz/)
2. 選擇你的 Provider 和 Channel
3. 在「Messaging API」設定中：
   - **Webhook URL**: `https://your-domain.com/webhook`
   - **Use webhook**: Enabled

### 步驟 8：驗證部署

```bash
# 檢查服務狀態
docker compose ps

# 檢查 Qdrant 向量數量
curl http://localhost:6333/collections/knowledge_base | jq '.result.points_count'

# 發送測試訊息到 LINE OA
```

---

## 重要注意事項

### 1. 幻覺防護

此 SKILL 已內建幻覺防護機制，LLM 不會：
- 捏造公司別稱
- 推測公司關係
- 創造不存在的資訊

### 2. 業務人員角度

回覆會以「業務人員向客戶解釋」的角度生成，不會直接引用內部備註。

### 3. 語氣模仿

系統會分析 Owner 的回覆風格，並模仿其語氣。

---

## 目錄結構

```
lineoa-create/
├── README.md               # 本文件
├── SKILL.md                # SKILL 說明文件
├── lineoa-create.skill     # OpenClaw SKILL 定義
├── assets/
│   ├── docker-compose.yml  # Docker Compose 設定
│   ├── .env.example        # 環境變數範本
│   ├── webhook/            # Webhook 服務
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.js    # 主程式
│   │       ├── rag.js      # RAG 檢索
│   │       ├── llm.js      # LLM 生成
│   │       └── db.js       # 資料庫
│   └── indexer/            # 索引服務
│       ├── Dockerfile
│       ├── package.json
│       └── indexer.js
├── references/             # 參考文件
└── scripts/                # 輔助腳本
```

---

## 常見問題

### Q: 為什麼需要 GPU Server？

A: BGE-m3 是一個大型中文 embedding 模型，需要 GPU 才能快速運算。如果沒有 GPU Server，可以改用 OpenAI text-embedding-3-small（付費）。

### Q: 支援哪些檔案格式？

A: PDF、Word (.docx, .doc)、Excel (.xlsx, .xls)、文字檔 (.txt, .md)

### Q: 如何更換 LLM 模型？

A: 修改 `.env` 中的 `LLM_MODEL`，例如：
- `gemini-2.5-flash`（預設）
- `gemini-2.5-pro`（更強大）
- `gemini-3-flash-preview`（預覽版）

---

## 授權

MIT License

---

## 聯繫方式

- 作者：Ken Chen
- Email：ken@sylksoft.com
