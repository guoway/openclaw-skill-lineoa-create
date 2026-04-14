"""t_auto_replies 資料存取層。"""

import json

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models.auto_reply import AutoReply


class AutoReplyRepository:
    """封裝自動回覆紀錄寫入。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        *,
        user_id: str,
        trigger_keyword: str | None,
        trigger_reason: str,
        user_question: str | None,
        rag_context: list[dict] | None,
        generated_reply: str,
        final_reply: str,
        retrieval_time_ms: int | None = None,
        generation_time_ms: int | None = None,
    ) -> AutoReply:
        """建立一筆 auto reply 紀錄。"""

        record = AutoReply(
            user_id=user_id,
            trigger_keyword=trigger_keyword,
            trigger_reason=trigger_reason,
            user_question=user_question,
            rag_context=json.dumps(rag_context or [], ensure_ascii=False),
            generated_reply=generated_reply,
            final_reply=final_reply,
            retrieval_time_ms=retrieval_time_ms,
            generation_time_ms=generation_time_ms,
        )
        self.db.add(record)
        self.db.flush()
        return record

    def count_all(self) -> int:
        """取得自動回覆總數。"""

        stmt = select(func.count()).select_from(AutoReply)
        return int(self.db.execute(stmt).scalar_one())
