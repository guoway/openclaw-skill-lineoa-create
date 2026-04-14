"""t_users ORM model。"""

from datetime import datetime

from sqlalchemy import Boolean, String, TIMESTAMP, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class User(Base):
    """儲存 LINE 使用者主檔資料。"""

    __tablename__ = "t_users"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    picture_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_owner: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("0"))
    create_time: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    update_time: Mapped[datetime] = mapped_column(
        TIMESTAMP,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=text("CURRENT_TIMESTAMP"),
    )
