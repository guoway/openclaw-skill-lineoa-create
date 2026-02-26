FROM node:20-alpine

# 安裝必要工具
RUN apk add --no-cache curl tzdata

# 設定時區
RUN ln -snf /usr/share/zoneinfo/Asia/Taipei /etc/localtime && echo Asia/Taipei > /etc/timezone

WORKDIR /app

# 複製 package 檔案
COPY package*.json ./

# 安裝依賴
RUN npm install --production

# 複製程式碼
COPY . .

# 建立 logs 目錄
RUN mkdir -p /app/logs

# 啟動服務
CMD ["node", "src/index.js"]
