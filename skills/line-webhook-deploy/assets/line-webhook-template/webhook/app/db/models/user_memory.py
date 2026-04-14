"""t_user_memory ORM model。"""

from datetime import datetime

from sqlalchemy import Integer, String, Text, TIMESTAMP, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserMemory(Base):
    """儲存每位用戶的長期互動記憶摘要。"""

    __tablename__ = "t_user_memory"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    topics: Mapped[str | None] = mapped_column(Text, nullable=True)
    preferences: Mapped[str | None] = mapped_column(Text, nullable=True)
    visit_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    last_conversation_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_interaction: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    create_time: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    update_time: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=text("CURRENT_TIMESTAMP"),
    )
