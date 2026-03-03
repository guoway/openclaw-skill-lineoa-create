-- MySQL 初始化腳本
-- LINE Bot 對話學習與 RAG 系統資料庫 Schema

CREATE DATABASE IF NOT EXISTS linebot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE linebot;

-- ============================================
-- 用戶資料表 (t_users)
-- ============================================
CREATE TABLE IF NOT EXISTS t_users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE COMMENT 'LINE User ID',
    display_name VARCHAR(255) COMMENT '顯示名稱',
    picture_url VARCHAR(500) COMMENT '頭像 URL',
    status_message TEXT COMMENT '狀態訊息',
    is_owner BOOLEAN DEFAULT FALSE COMMENT '是否為 Owner',
    is_blocked BOOLEAN DEFAULT FALSE COMMENT '是否被封鎖',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_is_owner (is_owner)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='LINE 用戶基本資料';

-- ============================================
-- 對話記錄表 (t_messages) - 核心：側錄所有對話
-- ============================================
CREATE TABLE IF NOT EXISTS t_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    message_id VARCHAR(255) COMMENT 'LINE Message ID',
    user_id VARCHAR(255) NOT NULL COMMENT '發送者 User ID',
    chat_type ENUM('user', 'group', 'room') DEFAULT 'user' COMMENT '聊天類型',
    chat_id VARCHAR(255) COMMENT '群組/聊天室 ID',
    reply_to_message_id VARCHAR(255) COMMENT '回覆的訊息 ID',
    
    -- 訊息內容
    message_type ENUM('text', 'image', 'video', 'audio', 'file', 'location', 'sticker', 'template', 'flex') DEFAULT 'text',
    content TEXT COMMENT '訊息文字內容（文字訊息時）',
    content_url VARCHAR(500) COMMENT '媒體檔案 URL（圖片/影片/音訊）',
    
    -- 語氣學習用欄位
    sentiment_score DECIMAL(4,2) COMMENT '情感分數 (-1 ~ 1)',
    message_intent VARCHAR(50) COMMENT '訊息意圖分類（問候、詢問、抱怨、感謝等）',
    
    -- 系統欄位
    is_processed BOOLEAN DEFAULT FALSE COMMENT '是否已處理（RAG 用）',
    is_auto_reply BOOLEAN DEFAULT FALSE COMMENT '是否為自動回覆',
    processing_time_ms INT UNSIGNED COMMENT '處理耗時（毫秒）',
    
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_chat_id (chat_id),
    INDEX idx_message_type (message_type),
    INDEX idx_create_time (create_time),
    INDEX idx_is_owner (user_id, create_time),
    FULLTEXT INDEX ft_content (content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='對話記錄 - 用於側錄與語氣學習';

-- ============================================
-- Owner 語氣特徵表 (t_owner_style)
-- ============================================
CREATE TABLE IF NOT EXISTS t_owner_style (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL COMMENT 'Owner User ID',
    
    -- 語氣特徵
    avg_sentence_length DECIMAL(5,2) COMMENT '平均句長',
    common_phrases JSON COMMENT '常用語（透過分析得出）',
    emoji_usage_pattern JSON COMMENT '表情符號使用模式',
    punctuation_style VARCHAR(50) COMMENT '標點風格',
    formality_level TINYINT COMMENT '正式程度 (1-5)',
    
    -- 常用回覆模板
    response_templates JSON COMMENT '高頻回覆模板',
    
    -- 分析統計
    total_messages_analyzed INT UNSIGNED DEFAULT 0 COMMENT '分析的總訊息數',
    last_analyzed_at DATETIME COMMENT '上次分析時間',
    
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY uk_user_id (user_id),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Owner 語氣特徵分析結果';

-- ============================================
-- RAG 知識庫文件表 (t_documents)
-- ============================================
CREATE TABLE IF NOT EXISTS t_documents (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    doc_id VARCHAR(255) NOT NULL UNIQUE COMMENT '文件唯一 ID',
    filename VARCHAR(500) NOT NULL COMMENT '原始檔名',
    file_path VARCHAR(500) COMMENT '檔案路徑',
    file_type VARCHAR(50) COMMENT '檔案類型 (pdf, docx, txt, md)',
    file_size BIGINT UNSIGNED COMMENT '檔案大小（bytes）',
    
    -- 內容資訊
    title VARCHAR(500) COMMENT '文件標題',
    description TEXT COMMENT '文件描述',
    content_hash VARCHAR(64) COMMENT '內容雜湊（用於偵測變更）',
    
    -- 處理狀態
    status ENUM('pending', 'processing', 'indexed', 'failed') DEFAULT 'pending',
    chunk_count INT UNSIGNED DEFAULT 0 COMMENT '切分後的 chunk 數量',
    error_message TEXT COMMENT '處理錯誤訊息',
    
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    indexed_at DATETIME COMMENT '完成索引時間',
    
    INDEX idx_status (status),
    INDEX idx_doc_id (doc_id),
    INDEX idx_create_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='RAG 知識庫文件管理';

-- ============================================
-- 自動回覆紀錄表 (t_auto_replies)
-- ============================================
CREATE TABLE IF NOT EXISTS t_auto_replies (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    trigger_message_id BIGINT UNSIGNED COMMENT '觸發的訊息 ID',
    user_id VARCHAR(255) NOT NULL COMMENT '用戶 ID',
    
    -- 觸發條件
    trigger_keyword VARCHAR(100) COMMENT '觸發的關鍵字',
    trigger_reason ENUM('keyword', 'timeout', 'owner_busy', 'fallback') COMMENT '觸發原因',
    
    -- 回覆內容
    user_question TEXT COMMENT '用戶問題',
    rag_context JSON COMMENT 'RAG 檢索到的相關內容',
    generated_reply TEXT COMMENT 'AI 生成的回覆',
    final_reply TEXT COMMENT '最終發送的回覆',
    
    -- 效能指標
    retrieval_time_ms INT UNSIGNED COMMENT '檢索耗時',
    generation_time_ms INT UNSIGNED COMMENT '生成耗時',
    
    -- 回饋
    user_feedback ENUM('positive', 'negative', 'none') DEFAULT 'none',
    feedback_comment TEXT COMMENT '用戶回饋內容',
    
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_create_time (create_time),
    INDEX idx_trigger_reason (trigger_reason)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='自動回覆記錄與效能追蹤';

-- ============================================
-- 系統設定表 (t_settings)
-- ============================================
CREATE TABLE IF NOT EXISTS t_settings (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) NOT NULL UNIQUE,
    setting_value TEXT,
    description VARCHAR(500),
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='系統設定';

-- 預設設定
INSERT INTO t_settings (setting_key, setting_value, description) VALUES
('auto_reply_enabled', 'true', '是否啟用自動回覆'),
('owner_response_timeout', '5', 'Owner 多久沒回覆才觸發（分鐘）'),
('max_rag_results', '5', 'RAG 最大檢索結果數'),
('reply_temperature', '0.7', '回覆生成溫度'),
('system_prompt', '你是一位專業且友善的客服助理，請根據提供的資料回答問題。', '系統提示詞'),
('owner_persona_prompt', '', 'Owner 語氣模仿提示詞（由系統自動生成）');
