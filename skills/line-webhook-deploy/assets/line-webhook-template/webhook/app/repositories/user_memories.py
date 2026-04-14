"""t_user_memory 資料存取層。"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.user_memory import UserMemory


class UserMemoryRepository:
    """封裝用戶記憶查詢。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_user_id(self, user_id: str) -> UserMemory | None:
        """依 user_id 取得用戶記憶。"""

        stmt = select(UserMemory).where(UserMemory.user_id == user_id).limit(1)
        return self.db.execute(stmt).scalar_one_or_none()

    def list_recent(self, *, limit: int = 10) -> list[UserMemory]:
        """列出最近互動的用戶記憶。"""

        stmt = select(UserMemory).order_by(UserMemory.last_interaction.desc()).limit(limit)
        return list(self.db.execute(stmt).scalars().all())

    def delete_by_user_id(self, user_id: str) -> int:
        """刪除指定用戶的記憶。"""

        record = self.get_by_user_id(user_id)
        if record is None:
            return 0
        self.db.delete(record)
        self.db.flush()
        return 1

    def upsert_summary(
        self,
        *,
        user_id: str,
        display_name: str | None,
        summary: str | None,
        topics: str | None,
        preferences: str | None,
        status: str,
        last_conversation_summary: str | None,
    ) -> UserMemory:
        """建立或更新用戶摘要。"""

        record = self.get_by_user_id(user_id)
        if record is None:
            record = UserMemory(
                user_id=user_id,
                display_name=display_name,
                summary=summary,
                topics=topics,
                preferences=preferences,
                visit_count=1,
                status=status,
                last_conversation_summary=last_conversation_summary,
            )
            self.db.add(record)
        else:
            record.display_name = display_name
            record.summary = summary
            record.topics = topics
            record.preferences = preferences
            record.visit_count = (record.visit_count or 0) + 1
            record.status = status
            record.last_conversation_summary = last_conversation_summary
        self.db.flush()
        return record
