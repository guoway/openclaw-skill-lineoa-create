"""t_messages 資料存取層。"""

from datetime import datetime, timedelta

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.db.models.message import Message


class MessageRepository:
    """封裝訊息流水表的查詢與寫入。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_message_id(self, message_id: str | None) -> Message | None:
        """依 message_id 查詢既有訊息。"""

        if not message_id:
            return None

        stmt = select(Message).where(Message.message_id == message_id).limit(1)
        return self.db.execute(stmt).scalar_one_or_none()

    def save_or_update_message(
        self,
        *,
        message_id: str | None,
        user_id: str,
        chat_type: str | None,
        chat_id: str,
        reply_to_message_id: str | None,
        message_type: str | None,
        content: str | None,
        is_owner: bool,
        is_auto_reply: bool,
    ) -> Message:
        """用 update-first 策略保存訊息，避免同一 message_id 重覆插入。"""

        message = self.get_by_message_id(message_id)
        if message is None:
            message = Message(
                message_id=message_id,
                user_id=user_id,
                chat_type=chat_type,
                chat_id=chat_id,
                reply_to_message_id=reply_to_message_id,
                message_type=message_type,
                content=content,
                is_owner=is_owner,
                is_auto_reply=is_auto_reply,
            )
            self.db.add(message)
        else:
            message.user_id = user_id
            message.chat_type = chat_type
            message.chat_id = chat_id
            message.reply_to_message_id = reply_to_message_id
            message.message_type = message_type
            message.content = content
            message.is_owner = is_owner
            message.is_auto_reply = bool(is_auto_reply or message.is_auto_reply)

        self.db.flush()
        return message

    def mark_auto_reply(self, message_id: str | None) -> None:
        """將既有訊息標記為已觸發 auto reply。"""

        message = self.get_by_message_id(message_id)
        if message is not None:
            message.is_auto_reply = True
            self.db.flush()

    def has_owner_replied_since(self, chat_id: str, timeout_minutes: int) -> bool:
        """判斷在指定分鐘數內是否已有 owner 回覆。"""

        threshold = datetime.now() - timedelta(minutes=timeout_minutes)
        stmt = (
            select(func.count())
            .select_from(Message)
            .where(Message.chat_id == chat_id)
            .where(Message.is_owner.is_(True))
            .where(Message.create_time > threshold)
        )
        count = self.db.execute(stmt).scalar_one()
        return count > 0

    def count_all(self) -> int:
        """取得訊息總數。"""

        stmt = select(func.count()).select_from(Message)
        return int(self.db.execute(stmt).scalar_one())

    def list_recent_owner_messages(self, *, owner_user_id: str, limit: int = 500) -> list[Message]:
        """取得指定 owner 最近的文字訊息，用於語氣分析。"""

        stmt = (
            select(Message)
            .where(Message.user_id == owner_user_id)
            .where(Message.message_type == "text")
            .where(Message.content.is_not(None))
            .order_by(desc(Message.create_time))
            .limit(limit)
        )
        return list(self.db.execute(stmt).scalars().all())
