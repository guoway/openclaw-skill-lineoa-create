"""t_owner_style ORM model。"""

from datetime import datetime

from sqlalchemy import Integer, String, Text, TIMESTAMP, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class OwnerStyle(Base):
    """儲存 owner 語氣分析結果。"""

    __tablename__ = "t_owner_style"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    avg_sentence_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    common_phrases: Mapped[str | None] = mapped_column(Text, nullable=True)
    emoji_usage_pattern: Mapped[str | None] = mapped_column(Text, nullable=True)
    punctuation_style: Mapped[str | None] = mapped_column(String(50), nullable=True)
    formality_level: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_templates: Mapped[str | None] = mapped_column(Text, nullable=True)
    total_messages_analyzed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_analyzed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    create_time: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    update_time: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=text("CURRENT_TIMESTAMP"),
    )
