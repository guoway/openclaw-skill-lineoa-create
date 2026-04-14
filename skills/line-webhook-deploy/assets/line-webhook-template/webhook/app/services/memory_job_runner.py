"""DB-based memory job runner。"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from app.core.config import Settings, get_settings
from app.core.logging import format_log_context, get_logger
from app.db.session import SessionLocal
from app.repositories.memory_jobs import MemoryJobRepository
from app.services.llm_service import LlmService
from app.services.memory_service import MemoryService

logger = get_logger(__name__)


class MemoryJobRunner:
    """定期掃描並執行到期的 memory jobs。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    async def run_once(self) -> int:
        """執行一輪到期 job。"""

        db = SessionLocal()
        try:
            repository = MemoryJobRepository(db)
            jobs = repository.list_due_jobs(now=datetime.now(), limit=20)
            processed = 0
            for job in jobs:
                repository.mark_processing(job)
                llm_service = LlmService(self.settings)
                memory_service = MemoryService(settings=self.settings, db=db, llm_service=llm_service)
                try:
                    await memory_service.update_user_memory(
                        user_id=job.user_id,
                        chat_id=job.chat_id,
                        display_name=job.display_name,
                    )
                    await memory_service.analyze_learning_opportunity(
                        chat_id=job.chat_id,
                        display_name=job.display_name,
                    )
                    repository.mark_done(job)
                    db.commit()
                    processed += 1
                except Exception as exc:
                    repository.mark_failed(job, error=str(exc))
                    db.commit()
                    logger.exception(
                        "memory job failed | %s",
                        format_log_context(job_key=job.job_key, chat_id=job.chat_id, user_id=job.user_id, error=str(exc)),
                    )
            return processed
        finally:
            db.close()

    async def watch(self, *, interval_seconds: int = 5) -> None:
        """長駐輪詢執行 memory jobs。"""

        while True:
            processed = await self.run_once()
            if processed:
                logger.info("memory jobs processed | %s", format_log_context(processed=processed))
            await asyncio.sleep(interval_seconds)


def build_due_time(*, delay_seconds: int) -> datetime:
    """依 delay seconds 建立 due time。"""

    return datetime.now() + timedelta(seconds=delay_seconds)
