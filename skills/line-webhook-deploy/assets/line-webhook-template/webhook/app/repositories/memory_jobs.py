"""t_memory_jobs 資料存取層。"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.memory_job import MemoryJob


class MemoryJobRepository:
    """封裝 memory job 佇列存取。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def upsert_pending_job(
        self,
        *,
        job_key: str,
        chat_id: str,
        user_id: str,
        display_name: str | None,
        due_time: datetime,
    ) -> MemoryJob:
        """建立或更新待執行 job。"""

        stmt = select(MemoryJob).where(MemoryJob.job_key == job_key).limit(1)
        record = self.db.execute(stmt).scalar_one_or_none()
        if record is None:
            record = MemoryJob(job_key=job_key, chat_id=chat_id, user_id=user_id, display_name=display_name, due_time=due_time)
            self.db.add(record)
        else:
            record.chat_id = chat_id
            record.user_id = user_id
            record.display_name = display_name
            record.due_time = due_time
            record.status = "pending"
            record.last_error = None
        self.db.flush()
        return record

    def list_due_jobs(self, *, now: datetime, limit: int = 20) -> list[MemoryJob]:
        """列出到期待執行 job。"""

        stmt = (
            select(MemoryJob)
            .where(MemoryJob.status == "pending")
            .where(MemoryJob.due_time <= now)
            .order_by(MemoryJob.due_time.asc())
            .limit(limit)
        )
        return list(self.db.execute(stmt).scalars().all())

    def mark_processing(self, job: MemoryJob) -> MemoryJob:
        """標記 job 執行中。"""

        job.status = "processing"
        job.attempt_count = (job.attempt_count or 0) + 1
        self.db.flush()
        return job

    def mark_done(self, job: MemoryJob) -> MemoryJob:
        """標記 job 已完成。"""

        job.status = "done"
        job.last_error = None
        job.processed_at = datetime.now()
        self.db.flush()
        return job

    def mark_failed(self, job: MemoryJob, *, error: str) -> MemoryJob:
        """標記 job 失敗，並回退為 pending 以便後續重試。"""

        job.status = "pending"
        job.last_error = error
        self.db.flush()
        return job
