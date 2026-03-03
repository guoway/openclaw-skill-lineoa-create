# Database Schema Reference

## Core Tables

### t_users

Stores LINE user profiles.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGINT PK | Auto-increment ID |
| user_id | VARCHAR(255) | LINE User ID (unique) |
| display_name | VARCHAR(255) | Display name from LINE |
| picture_url | VARCHAR(500) | Profile picture URL |
| is_owner | BOOLEAN | Whether this user is the owner |
| create_time | DATETIME | Record creation time |

### t_messages (Core Conversation Log)

Stores all messages for conversation learning.

| Column | Type | Description |
|--------|------|-------------|
| id | BIGINT PK | Auto-increment ID |
| message_id | VARCHAR(255) | LINE Message ID |
| user_id | VARCHAR(255) | Sender's User ID |
| chat_type | ENUM | user/group/room |
| chat_id | VARCHAR(255) | Group/Room ID or User ID |
| message_type | ENUM | text/image/video/etc |
| content | TEXT | Message text content |
| is_owner | BOOLEAN | Whether sent by owner |
| is_auto_reply | BOOLEAN | Whether auto-generated |
| create_time | DATETIME | Message timestamp |

Key indexes:
- `idx_user_id` - Query by user
- `idx_chat_id` - Query by conversation
- `idx_is_owner` - Filter owner messages
- `ft_content` - Full-text search

### t_owner_style

Stores analyzed owner speaking characteristics.

| Column | Type | Description |
|--------|------|-------------|
| user_id | VARCHAR(255) | Owner's User ID |
| avg_sentence_length | DECIMAL | Average sentence length |
| common_phrases | JSON | Frequently used phrases |
| emoji_usage_pattern | JSON | Emoji usage statistics |
| punctuation_style | VARCHAR(50) | Punctuation preferences |
| formality_level | TINYINT | Formality level (1-5) |
| total_messages_analyzed | INT | Sample size for analysis |
| last_analyzed_at | DATETIME | Last analysis timestamp |

### t_auto_replies

Tracks auto-reply performance.

| Column | Type | Description |
|--------|------|-------------|
| user_id | VARCHAR(255) | Recipient User ID |
| trigger_keyword | VARCHAR(100) | Which keyword triggered |
| user_question | TEXT | Original question |
| rag_context | JSON | Retrieved context |
| generated_reply | TEXT | AI-generated response |
| retrieval_time_ms | INT | RAG retrieval latency |
| generation_time_ms | INT | LLM generation latency |
| user_feedback | ENUM | positive/negative/none |

### t_documents

Tracks knowledge base documents.

| Column | Type | Description |
|--------|------|-------------|
| doc_id | VARCHAR(255) | Unique document ID |
| filename | VARCHAR(500) | Original filename |
| file_type | VARCHAR(50) | pdf/docx/txt/md |
| status | ENUM | pending/processing/indexed/failed |
| chunk_count | INT | Number of text chunks |
| indexed_at | DATETIME | Index completion time |

### t_settings

System configuration storage.

| Column | Type | Description |
|--------|------|-------------|
| setting_key | VARCHAR(100) | Setting name (unique) |
| setting_value | TEXT | Setting value |

Default settings:
- `auto_reply_enabled`: true/false
- `owner_response_timeout`: minutes
- `max_rag_results`: number of chunks
- `reply_temperature`: 0.0-1.0
- `system_prompt`: base system prompt
- `owner_persona_prompt`: owner style prompt

## Vector Store (Qdrant)

Collection: `knowledge_base`

Point structure:
```json
{
    "id": "doc_hash_chunk_N",
    "vector": [1536-dimensional embedding],
    "payload": {
        "content": "text content",
        "source": "filename.pdf",
        "metadata": {
            "source_id": "file_hash",
            "chunk_index": 0,
            "total_chunks": 10
        }
    }
}
```

Distance metric: Cosine
Vector size: 1536 (text-embedding-3-small)
