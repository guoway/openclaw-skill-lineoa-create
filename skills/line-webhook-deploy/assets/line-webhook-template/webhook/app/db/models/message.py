"""t_messages ORM model。"""

from datetime import datetime

from sqlalchemy import Boolean, String, Text, TIMESTAMP, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Message(Base):
    """儲存 LINE 對話流水的核心資料表。"""

    __tablename__ = "t_messages"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    message_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    chat_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    chat_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    reply_to_message_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    message_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_owner: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("0"))
    is_auto_reply: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("0"))
    create_time: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    update_time: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=text("CURRENT_TIMESTAMP"),
    )
