"""t_chat_modes 資料存取層。"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.chat_mode import ChatMode


class ChatModeRepository:
    """封裝 chat mode 的資料存取邏輯。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_mode(self, chat_id: str) -> str:
        """取得 chat 模式，若不存在則預設回傳 auto。"""

        stmt = select(ChatMode).where(ChatMode.chat_id == chat_id)
        result = self.db.execute(stmt).scalar_one_or_none()
        return result.mode if result else "auto"

    def set_mode(self, *, chat_id: str, mode: str, updated_by: str | None) -> ChatMode:
        """設定 chat mode，若不存在則建立。"""

        stmt = select(ChatMode).where(ChatMode.chat_id == chat_id)
        record = self.db.execute(stmt).scalar_one_or_none()
        if record is None:
            record = ChatMode(chat_id=chat_id, mode=mode, updated_by=updated_by)
            self.db.add(record)
        else:
            record.mode = mode
            record.updated_by = updated_by
        self.db.flush()
        return record
