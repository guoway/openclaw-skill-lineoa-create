"""對話記憶服務。"""

import asyncio
import json
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.logging import format_log_context, get_logger
from app.db.models.message import Message
from app.db.models.user_memory import UserMemory
from app.repositories.learned_knowledge import LearnedKnowledgeRepository
from app.repositories.memory_jobs import MemoryJobRepository
from app.repositories.user_memories import UserMemoryRepository
from app.services.llm_service import LlmService


logger = get_logger(__name__)

_conversation_timers: dict[str, asyncio.Task] = {}


class MemoryService:
    """提供短期上下文與用戶記憶格式化能力。"""

    def __init__(self, settings: Settings, db: Session, llm_service: LlmService | None = None) -> None:
        self.settings = settings
        self.db = db
        self.user_memory_repository = UserMemoryRepository(db)
        self.learned_knowledge_repository = LearnedKnowledgeRepository(db)
        self.memory_job_repository = MemoryJobRepository(db)
        self.llm_service = llm_service

    def get_recent_conversation(self, *, chat_id: str, current_user_id: str) -> list[dict[str, str]]:
        """取得最近 30 分鐘 / 10 則內的對話上下文。"""

        threshold = datetime.now() - timedelta(minutes=30)
        stmt = (
            select(Message)
            .where(Message.chat_id == chat_id)
            .where(Message.content.is_not(None))
            .where(Message.content != "")
            .where(Message.message_type == "text")
            .where(Message.create_time > threshold)
            .order_by(Message.create_time.desc())
            .limit(10)
        )
        rows = list(self.db.execute(stmt).scalars().all())
        rows.reverse()

        messages: list[dict[str, str]] = []
        for row in rows:
            role = "assistant" if row.is_auto_reply else "user"
            prefix = ""
            if not row.is_auto_reply and not row.is_owner and row.user_id != current_user_id:
                prefix = f"[{row.user_id}] "
            messages.append({"role": role, "content": f"{prefix}{row.content}"})
        return messages

    def get_user_memory(self, user_id: str) -> UserMemory | None:
        """取得用戶長期記憶。"""

        stmt = select(UserMemory).where(UserMemory.user_id == user_id).limit(1)
        return self.db.execute(stmt).scalar_one_or_none()

    def format_user_memory_for_prompt(self, memory: UserMemory | None) -> str:
        """將用戶記憶轉成 prompt 片段。"""

        if memory is None or not memory.summary:
            return ""

        lines = ["\n【用戶記憶】", f"- 摘要：{memory.summary}"]

        if memory.topics:
            try:
                topics = json.loads(memory.topics)
            except json.JSONDecodeError:
                topics = []
            if topics:
                lines.append(f"- 關心主題：{'、'.join(topics)}")

        if memory.preferences:
            try:
                preferences = json.loads(memory.preferences)
            except json.JSONDecodeError:
                preferences = {}
            if preferences:
                pref_text = "、".join(f"{key}: {value}" for key, value in preferences.items())
                lines.append(f"- 偏好：{pref_text}")

        if memory.status:
            lines.append(f"- 用戶類型：{memory.status}（第 {memory.visit_count or 1} 次互動）")

        if memory.last_conversation_summary:
            lines.append(f"- 上次對話：{memory.last_conversation_summary}")

        return "\n".join(lines) + "\n"

    def get_full_conversation_text(self, *, chat_id: str, display_name: str | None) -> str:
        """取得最近一段完整對話文字，用於摘要。"""

        threshold = datetime.now() - timedelta(hours=2)
        stmt = (
            select(Message)
            .where(Message.chat_id == chat_id)
            .where(Message.content.is_not(None))
            .where(Message.content != "")
            .where(Message.message_type == "text")
            .where(Message.create_time > threshold)
            .order_by(Message.create_time.asc())
        )
        rows = list(self.db.execute(stmt).scalars().all())
        lines: list[str] = []
        for row in rows:
            role = "Bot" if row.is_auto_reply else ("Owner" if row.is_owner else f"用戶({display_name or row.user_id})")
            lines.append(f"{role}: {row.content}")
        return "\n".join(lines)

    async def update_user_memory(self, *, user_id: str, chat_id: str, display_name: str | None) -> bool:
        """依最近對話更新用戶記憶摘要。"""

        if self.llm_service is None:
            return False

        conversation_text = self.get_full_conversation_text(chat_id=chat_id, display_name=display_name)
        if not conversation_text.strip():
            return False

        existing_memory = self.get_user_memory(user_id)
        summary = await self.llm_service.generate_memory_summary(
            existing_memory=existing_memory,
            conversation_text=conversation_text,
            display_name=display_name,
        )
        if not summary:
            return False

        self.user_memory_repository.upsert_summary(
            user_id=user_id,
            display_name=display_name,
            summary=summary.get("summary"),
            topics=json.dumps(summary.get("topics", []), ensure_ascii=False),
            preferences=json.dumps(summary.get("preferences", {}), ensure_ascii=False),
            status=summary.get("status") or "新訪客",
            last_conversation_summary=summary.get("last_conversation_summary"),
        )
        self.db.flush()
        return True

    def get_owner_correction_conversation_text(self, *, chat_id: str, display_name: str | None) -> str:
        """擷取 owner correction 對話片段，供 learned knowledge 分析。"""

        threshold = datetime.now() - timedelta(hours=2)
        stmt = (
            select(Message)
            .where(Message.chat_id == chat_id)
            .where(Message.content.is_not(None))
            .where(Message.content != "")
            .where(Message.message_type == "text")
            .where(Message.create_time > threshold)
            .order_by(Message.create_time.asc())
        )
        rows = list(self.db.execute(stmt).scalars().all())
        pairs: list[str] = []
        for index in range(1, len(rows)):
            previous = rows[index - 1]
            current = rows[index]
            if (not previous.is_owner) and (not previous.is_auto_reply) and current.is_owner:
                pairs.append(f"客戶({display_name or previous.user_id}): {previous.content}\nOwner: {current.content}")
        return "\n\n".join(pairs)

    async def analyze_learning_opportunity(self, *, chat_id: str, display_name: str | None) -> int:
        """分析對話是否值得生成 pending learned knowledge。"""

        if self.llm_service is None:
            return 0

        conversation_text = self.get_owner_correction_conversation_text(chat_id=chat_id, display_name=display_name)
        if not conversation_text.strip():
            return 0

        suggestions = await self.llm_service.analyze_learning_suggestions(conversation_text=conversation_text)
        created = 0
        for item in suggestions:
            content = (item.get("content") or "").strip()
            if not content:
                continue
            title = (item.get("title") or content[:50]).strip()[:255]
            existing = self.learned_knowledge_repository.find_similar_existing(title=title, content=content)
            if existing is not None:
                continue
            self.learned_knowledge_repository.create(
                source_type="owner_correction",
                source_chat_id=chat_id,
                source_message_ids=None,
                title=title,
                content=content,
                category=(item.get("category") or "其他").strip()[:100],
                status="pending",
            )
            created += 1
        if created > 0:
            self.db.flush()
        return created

    def schedule_memory_update(
        self,
        *,
        chat_id: str,
        user_id: str,
        display_name: str | None,
        delay_seconds: int = 1800,
        on_fire: Callable[[str, str, str | None], None] | None = None,
    ) -> str:
        """為指定 chat/user 排程延後更新記憶。"""

        timer_key = f"{chat_id}:{user_id}"
        due_time = datetime.now() + timedelta(seconds=delay_seconds)
        self.memory_job_repository.upsert_pending_job(
            job_key=timer_key,
            chat_id=chat_id,
            user_id=user_id,
            display_name=display_name,
            due_time=due_time,
        )
        self.db.flush()

        existing_task = _conversation_timers.get(timer_key)
        if existing_task is not None and not existing_task.done():
            existing_task.cancel()

        async def runner() -> None:
            try:
                await asyncio.sleep(delay_seconds)
                if on_fire is not None:
                    result = on_fire(chat_id, user_id, display_name)
                    if asyncio.iscoroutine(result):
                        await result
            except asyncio.CancelledError:
                logger.info("memory scheduler cancelled | %s", format_log_context(chat_id=chat_id, user_id=user_id))
                return
            except Exception as exc:
                logger.exception(
                    "memory scheduler failed | %s",
                    format_log_context(chat_id=chat_id, user_id=user_id, error=str(exc)),
                )
            finally:
                current_task = _conversation_timers.get(timer_key)
                if current_task is asyncio.current_task():
                    _conversation_timers.pop(timer_key, None)

        _conversation_timers[timer_key] = asyncio.create_task(runner())
        return timer_key
