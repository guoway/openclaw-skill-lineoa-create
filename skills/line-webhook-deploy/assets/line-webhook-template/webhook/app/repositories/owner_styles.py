"""t_owner_style 資料存取層。"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.owner_style import OwnerStyle


class OwnerStyleRepository:
    """封裝 owner style 讀取邏輯。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_first_available(self, owner_user_ids: list[str]) -> OwnerStyle | None:
        """依 owner 清單順序，回傳第一筆可用語氣資料。"""

        for owner_user_id in owner_user_ids:
            stmt = select(OwnerStyle).where(OwnerStyle.user_id == owner_user_id).limit(1)
            record = self.db.execute(stmt).scalar_one_or_none()
            if record is not None:
                return record
        return None

    def upsert_analysis(
        self,
        *,
        owner_user_id: str,
        avg_sentence_length: int | None,
        common_phrases: str,
        emoji_usage_pattern: str | None,
        punctuation_style: str | None,
        formality_level: int | None,
        total_messages_analyzed: int,
    ) -> OwnerStyle:
        """建立或更新 owner style 分析結果。"""

        stmt = select(OwnerStyle).where(OwnerStyle.user_id == owner_user_id).limit(1)
        record = self.db.execute(stmt).scalar_one_or_none()
        if record is None:
            record = OwnerStyle(user_id=owner_user_id)
            self.db.add(record)

        record.avg_sentence_length = avg_sentence_length
        record.common_phrases = common_phrases
        record.emoji_usage_pattern = emoji_usage_pattern
        record.punctuation_style = punctuation_style
        record.formality_level = formality_level
        record.total_messages_analyzed = total_messages_analyzed
        record.last_analyzed_at = datetime.now()
        self.db.flush()
        return record
