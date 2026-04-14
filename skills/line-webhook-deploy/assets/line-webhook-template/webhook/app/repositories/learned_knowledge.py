"""t_learned_knowledge 資料存取層。"""

from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db.models.learned_knowledge import LearnedKnowledge


class LearnedKnowledgeRepository:
    """封裝已核准知識查詢。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def list_approved(self, *, category: str | None = None) -> list[LearnedKnowledge]:
        """取得已通過審核的知識內容。"""

        stmt = select(LearnedKnowledge).where(LearnedKnowledge.status == "approved").order_by(LearnedKnowledge.create_time.desc())
        if category:
            stmt = stmt.where(LearnedKnowledge.category == category)
        return list(self.db.execute(stmt).scalars().all())

    def list_pending(self, *, limit: int = 5) -> list[LearnedKnowledge]:
        """取得待審核知識。"""

        stmt = (
            select(LearnedKnowledge)
            .where(LearnedKnowledge.status == "pending")
            .order_by(LearnedKnowledge.create_time.asc())
            .limit(limit)
        )
        return list(self.db.execute(stmt).scalars().all())

    def create(
        self,
        *,
        source_type: str,
        source_chat_id: str | None,
        source_message_ids: str | None,
        title: str | None,
        content: str,
        category: str | None,
        status: str = "pending",
        reviewed_by: str | None = None,
    ) -> LearnedKnowledge:
        """建立一筆學習知識。"""

        record = LearnedKnowledge(
            source_type=source_type,
            source_chat_id=source_chat_id,
            source_message_ids=source_message_ids,
            title=title,
            content=content,
            category=category,
            status=status,
            reviewed_by=reviewed_by,
            reviewed_at=datetime.now() if status == "approved" else None,
        )
        self.db.add(record)
        self.db.flush()
        return record

    def find_similar_existing(self, *, title: str | None, content: str) -> LearnedKnowledge | None:
        """查找已存在的相近 pending / approved learned knowledge。"""

        normalized_title = (title or "").strip()
        normalized_content = content.strip()
        content_prefix = normalized_content[:80]

        stmt = select(LearnedKnowledge).where(
            LearnedKnowledge.status.in_(["pending", "approved"]),
            or_(
                LearnedKnowledge.content == normalized_content,
                LearnedKnowledge.content.like(f"{content_prefix}%"),
                LearnedKnowledge.title == normalized_title if normalized_title else False,
            ),
        ).limit(1)
        return self.db.execute(stmt).scalar_one_or_none()

    def review(
        self,
        *,
        knowledge_id: int,
        action: str,
        reviewer_id: str,
        reject_reason: str | None = None,
    ) -> LearnedKnowledge | None:
        """審核學習知識。"""

        stmt = select(LearnedKnowledge).where(LearnedKnowledge.id == knowledge_id).limit(1)
        record = self.db.execute(stmt).scalar_one_or_none()
        if record is None or record.status != "pending":
            return None

        record.status = action
        record.reviewed_by = reviewer_id
        record.reviewed_at = datetime.now()
        record.reject_reason = reject_reason if action == "rejected" else None
        self.db.flush()
        return record
