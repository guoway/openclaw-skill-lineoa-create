"""應用程式設定模組。"""

from functools import lru_cache
from typing import List, Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """集中管理 Python 版 line-webhook 的執行設定。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "line-webhook-python"
    app_env: str = Field(default="development", alias="APP_ENV")
    app_debug: bool = Field(default=False, alias="APP_DEBUG")
    port: int = Field(default=3000, alias="PORT")
    timezone: str = Field(default="Asia/Taipei", alias="TZ")

    db_host: str = Field(default="mysql", alias="DB_HOST")
    db_port: int = Field(default=3306, alias="DB_PORT")
    db_name: str = Field(default="linebot", alias="DB_NAME")
    db_user: str = Field(default="linebot", alias="DB_USER")
    db_password: str = Field(default="linebot123", alias="DB_PASSWORD")

    qdrant_host: str = Field(default="qdrant", alias="QDRANT_HOST")
    qdrant_port: int = Field(default=6333, alias="QDRANT_PORT")
    qdrant_collection: str = Field(default="knowledge_base", alias="QDRANT_COLLECTION")

    line_channel_access_token: Optional[str] = Field(default=None, alias="LINE_CHANNEL_ACCESS_TOKEN")
    line_channel_secret: Optional[str] = Field(default=None, alias="LINE_CHANNEL_SECRET")
    internal_api_token: Optional[str] = Field(default=None, alias="INTERNAL_API_TOKEN")

    openai_api_key: Optional[str] = Field(default=None, alias="OPENAI_API_KEY")
    openai_base_url: str = Field(default="https://api.openai.com/v1", alias="OPENAI_BASE_URL")
    llm_model: str = Field(default="kimi-k2.5", alias="LLM_MODEL")
    embedding_model: str = Field(default="text-embedding-3-small", alias="EMBEDDING_MODEL")

    auto_reply_keywords_raw: str = Field(default="問,查詢,help,怎麼,如何,多少錢", alias="AUTO_REPLY_KEYWORDS")
    owner_response_timeout: int = Field(default=5, alias="OWNER_RESPONSE_TIMEOUT")
    knowledge_base_dir: str = Field(default="/app/knowledge", alias="KNOWLEDGE_BASE_DIR")

    use_ollama_embeddings: bool = Field(default=False, alias="USE_OLLAMA_EMBEDDINGS")
    ollama_api_url: str = Field(default="http://ollama.sylksoft.com:11434", alias="OLLAMA_API_URL")
    ollama_embedding_model: str = Field(default="bge-m3", alias="OLLAMA_EMBEDDING_MODEL")
    use_gemini_embeddings: bool = Field(default=False, alias="USE_GEMINI_EMBEDDINGS")

    @property
    def sqlalchemy_database_uri(self) -> str:
        """組合 SQLAlchemy 連線字串。"""

        return (
            f"mysql+pymysql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}?charset=utf8mb4"
        )

    @property
    def qdrant_url(self) -> str:
        """回傳 Qdrant API Base URL。"""

        return f"http://{self.qdrant_host}:{self.qdrant_port}"

    @property
    def auto_reply_keywords(self) -> List[str]:
        """將自動回覆關鍵字正規化為 list。"""

        return [item.strip() for item in self.auto_reply_keywords_raw.split(",") if item.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """回傳全域單例設定。"""

    return Settings()
