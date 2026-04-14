"""t_auto_replies ORM model。"""

from datetime import datetime

from sqlalchemy import Integer, String, Text, TIMESTAMP, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AutoReply(Base):
    """記錄 AI 自動回覆的觸發與結果。"""

    __tablename__ = "t_auto_replies"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    trigger_keyword: Mapped[str | None] = mapped_column(String(255), nullable=True)
    trigger_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_question: Mapped[str | None] = mapped_column(Text, nullable=True)
    rag_context: Mapped[str | None] = mapped_column(Text, nullable=True)
    generated_reply: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_reply: Mapped[str | None] = mapped_column(Text, nullable=True)
    retrieval_time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    generation_time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    create_time: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
