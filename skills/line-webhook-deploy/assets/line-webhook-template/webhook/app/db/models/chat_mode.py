"""t_chat_modes ORM model。"""

from sqlalchemy import Enum, String, TIMESTAMP, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ChatMode(Base):
    """對應每個 chat 當前自動/手動模式設定。"""

    __tablename__ = "t_chat_modes"

    chat_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    mode: Mapped[str] = mapped_column(Enum("auto", "manual", name="chat_mode_enum"), nullable=False, server_default="auto")
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    update_time: Mapped[str] = mapped_column(
        TIMESTAMP,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=text("CURRENT_TIMESTAMP"),
    )
