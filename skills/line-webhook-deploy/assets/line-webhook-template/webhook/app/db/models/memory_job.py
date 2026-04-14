"""t_memory_jobs ORM model。"""

from datetime import datetime

from sqlalchemy import Integer, String, Text, TIMESTAMP, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MemoryJob(Base):
    """儲存延後執行的 memory / learning job。"""

    __tablename__ = "t_memory_jobs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    job_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    chat_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default=text("'pending'"), index=True)
    due_time: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, index=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    create_time: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    update_time: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=text("CURRENT_TIMESTAMP"),
    )
    processed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
