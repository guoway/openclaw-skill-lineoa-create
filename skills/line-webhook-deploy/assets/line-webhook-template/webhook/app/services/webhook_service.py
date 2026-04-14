"""Webhook 主流程服務。"""

from dataclasses import dataclass
from time import perf_counter

from sqlalchemy.orm import Session

from app.clients.line_client import LineClient
from app.core.config import Settings
from app.core.logging import format_log_context, get_logger
from app.repositories.auto_replies import AutoReplyRepository
from app.repositories.chat_modes import ChatModeRepository
from app.repositories.learned_knowledge import LearnedKnowledgeRepository
from app.repositories.messages import MessageRepository
from app.repositories.owner_styles import OwnerStyleRepository
from app.repositories.settings import SettingRepository
from app.repositories.user_memories import UserMemoryRepository
from app.repositories.users import UserRepository
from app.schemas.line_events import LineWebhookEvent
from app.services.auto_reply_service import AutoReplyDecisionService
from app.services.llm_service import LlmService
from app.services.memory_service import MemoryService
from app.services.owner_config_service import OwnerConfigError, OwnerConfigService
from app.services.rag_service import RagService


@dataclass
class WebhookProcessResult:
    """描述單一 event 處理結果。"""

    processed: bool
    reason: str


logger = get_logger(__name__)


class WebhookService:
    """負責 webhook event 的最小處理流程。"""

    def __init__(self, settings: Settings, db: Session) -> None:
        self.settings = settings
        self.db = db
        self.user_repository = UserRepository(db)
        self.message_repository = MessageRepository(db)
        self.chat_mode_repository = ChatModeRepository(db)
        self.auto_reply_repository = AutoReplyRepository(db)
        self.setting_repository = SettingRepository(db)
        self.owner_style_repository = OwnerStyleRepository(db)
        self.user_memory_repository = UserMemoryRepository(db)
        self.learned_knowledge_repository = LearnedKnowledgeRepository(db)
        self.line_client = LineClient(settings)
        self.owner_config_service = OwnerConfigService(
            setting_repository=self.setting_repository,
            user_repository=self.user_repository,
        )
        self.auto_reply_decision_service = AutoReplyDecisionService(
            owner_user_ids_provider=self.owner_config_service.get_owner_user_ids,
            auto_reply_keywords=settings.auto_reply_keywords,
            owner_response_timeout=settings.owner_response_timeout,
        )
        self.rag_service = RagService(settings=settings)
        self.llm_service = LlmService(settings=settings)
        self.memory_service = MemoryService(settings=settings, db=db, llm_service=self.llm_service)

    def is_owner(self, user_id: str | None) -> bool:
        """判斷 user 是否為 owner。"""

        return self.auto_reply_decision_service.is_owner(user_id)

    async def process_event(self, event: LineWebhookEvent) -> WebhookProcessResult:
        """根據 event 類型分派處理邏輯。"""

        if event.type == "message" and event.message and event.source.user_id:
            return await self._handle_message_event(event)

        if event.type == "follow" and event.source.user_id:
            await self._handle_follow_event(event)
            return WebhookProcessResult(processed=True, reason="follow_handled")

        return WebhookProcessResult(processed=False, reason=f"ignored:{event.type}")

    async def _handle_message_event(self, event: LineWebhookEvent) -> WebhookProcessResult:
        """處理 message event，完成 user/profile、message 寫入與第一版 auto-reply decision。"""

        user_id = event.source.user_id
        assert user_id is not None

        profile = await self.line_client.get_user_profile(user_id)
        self.user_repository.upsert_basic_profile(
            user_id=user_id,
            display_name=profile.get("displayName") if profile else None,
            picture_url=profile.get("pictureUrl") if profile else None,
            status_message=profile.get("statusMessage") if profile else None,
            is_owner=self.is_owner(user_id),
        )

        chat_id = event.source.group_id or event.source.room_id or user_id
        self.message_repository.save_or_update_message(
            message_id=event.message.id,
            user_id=user_id,
            chat_type=event.source.type,
            chat_id=chat_id,
            reply_to_message_id=event.message.quote_token,
            message_type=event.message.type,
            content=event.message.text,
            is_owner=self.is_owner(user_id),
            is_auto_reply=False,
        )

        command_result = await self._handle_owner_command_if_needed(
            event=event,
            user_id=user_id,
            chat_id=chat_id,
            display_name=profile.get("displayName") if profile else None,
        )
        if command_result is not None:
            self.db.commit()
            return command_result

        chat_mode = self.chat_mode_repository.get_mode(chat_id)
        owner_replied_recently = self.message_repository.has_owner_replied_since(
            chat_id=chat_id,
            timeout_minutes=self.settings.owner_response_timeout,
        )
        bot_mentioned = self._is_bot_mentioned(event)
        decision = self.auto_reply_decision_service.decide(
            user_id=user_id,
            chat_type=event.source.type,
            chat_mode=chat_mode,
            message_text=event.message.text,
            bot_mentioned=bot_mentioned,
            owner_replied_recently=owner_replied_recently,
        )

        logger.info(
            "webhook message received | %s",
            format_log_context(
                chat_id=chat_id,
                user_id=user_id,
                chat_type=event.source.type,
                decision=decision.reason,
                should_reply=decision.should_reply,
            ),
        )

        # 全域 auto reply 開關 gate
        if not self._is_auto_reply_enabled():
            logger.info(
                "auto reply disabled by setting | %s",
                format_log_context(chat_id=chat_id, user_id=user_id),
            )
            self.db.commit()
            return WebhookProcessResult(processed=True, reason="auto_reply_disabled")

        if decision.should_reply and event.reply_token:
            retrieval_started_at = perf_counter()
            rag_results: list[dict] = []
            retrieval_time_ms: int | None = None
            generation_time_ms: int | None = None

            try:
                rag_results = await self.rag_service.search_similar(event.message.text or "", limit=5)
                retrieval_time_ms = int((perf_counter() - retrieval_started_at) * 1000)

                conversation_history = self.memory_service.get_recent_conversation(chat_id=chat_id, current_user_id=user_id)
                user_memory = self.memory_service.get_user_memory(user_id)
                user_memory_text = self.memory_service.format_user_memory_for_prompt(user_memory)
                owner_style = self.owner_style_repository.get_first_available(self.owner_config_service.get_owner_user_ids())
                learned_knowledge_records = self.learned_knowledge_repository.list_approved()
                learned_knowledge = [
                    {"title": item.title, "content": item.content, "category": item.category}
                    for item in learned_knowledge_records
                ]

                generation_started_at = perf_counter()
                reply_text = await self.llm_service.generate_reply(
                    user_question=event.message.text or "",
                    rag_results=rag_results,
                    owner_style=owner_style,
                    conversation_history=conversation_history,
                    user_memory_text=user_memory_text,
                    learned_knowledge=learned_knowledge,
                )
                generation_time_ms = int((perf_counter() - generation_started_at) * 1000)
            except Exception as exc:
                logger.exception(
                    "auto reply generation failed, fallback reply used | %s",
                    format_log_context(
                        chat_id=chat_id,
                        user_id=user_id,
                        reason=decision.reason,
                        error=str(exc),
                    ),
                )
                reply_text = self._build_fallback_reply(
                    user_question=event.message.text,
                    rag_results=rag_results,
                )
                if retrieval_time_ms is None:
                    retrieval_time_ms = int((perf_counter() - retrieval_started_at) * 1000)

            await self.line_client.reply_text(event.reply_token, reply_text)
            self.message_repository.mark_auto_reply(event.message.id)
            self.auto_reply_repository.create(
                user_id=user_id,
                trigger_keyword=decision.trigger_keyword,
                trigger_reason=decision.reason,
                user_question=event.message.text,
                rag_context=rag_results,
                generated_reply=reply_text,
                final_reply=reply_text,
                retrieval_time_ms=retrieval_time_ms,
                generation_time_ms=generation_time_ms,
            )

        if event.message.text:
            timer_key = self.memory_service.schedule_memory_update(
                user_id=user_id,
                chat_id=chat_id,
                display_name=profile.get("displayName") if profile else None,
            )
            logger.info(
                "memory update scheduled | %s",
                format_log_context(chat_id=chat_id, user_id=user_id, timer_key=timer_key),
            )

        self.db.commit()
        return WebhookProcessResult(processed=True, reason=decision.reason)

    async def _handle_follow_event(self, event: LineWebhookEvent) -> None:
        """處理 follow event，先建立/更新用戶主檔。"""

        user_id = event.source.user_id
        assert user_id is not None

        profile = await self.line_client.get_user_profile(user_id)
        self.user_repository.upsert_basic_profile(
            user_id=user_id,
            display_name=profile.get("displayName") if profile else None,
            picture_url=profile.get("pictureUrl") if profile else None,
            status_message=profile.get("statusMessage") if profile else None,
            is_owner=self.is_owner(user_id),
        )
        self.db.commit()

    async def _handle_owner_command_if_needed(
        self,
        *,
        event: LineWebhookEvent,
        user_id: str,
        chat_id: str,
        display_name: str | None,
    ) -> WebhookProcessResult | None:
        """處理 owner commands。"""

        if not event.reply_token or not event.message or not event.message.text:
            return None

        is_direct_chat = event.source.type == "user"
        if not self.is_owner(user_id) or not is_direct_chat:
            return None

        raw_text = event.message.text.strip()
        lowered = raw_text.lower()

        if lowered == "/auto":
            self.chat_mode_repository.set_mode(chat_id=chat_id, mode="auto", updated_by=user_id)
            await self.line_client.reply_text(event.reply_token, "✅ 已切換為自動回覆模式")
            return WebhookProcessResult(processed=True, reason="command_auto")

        if lowered == "/manual":
            self.chat_mode_repository.set_mode(chat_id=chat_id, mode="manual", updated_by=user_id)
            await self.line_client.reply_text(event.reply_token, "✅ 已切換為手動模式")
            return WebhookProcessResult(processed=True, reason="command_manual")

        if lowered == "/status":
            mode = self.chat_mode_repository.get_mode(chat_id)
            pending = self.learned_knowledge_repository.list_pending(limit=3)
            owners = self.owner_config_service.get_owner_user_ids()
            message = f"📊 目前模式：{'自動回覆 🤖' if mode == 'auto' else '手動模式 👤'}"
            message += f"\n👑 Owner：{', '.join(owners)}"
            if pending:
                message += f"\n📚 待審核學習建議：{len(pending)} 筆"
            await self.line_client.reply_text(event.reply_token, message)
            return WebhookProcessResult(processed=True, reason="command_status")

        if lowered == "/memory":
            memories = self.user_memory_repository.list_recent(limit=10)
            if not memories:
                await self.line_client.reply_text(event.reply_token, "📝 目前沒有任何用戶記憶。")
                return WebhookProcessResult(processed=True, reason="command_memory")
            lines = [f"📝 用戶記憶摘要（最近 {len(memories)} 位）"]
            for item in memories:
                lines.append(f"👤 {item.display_name or item.user_id}")
                lines.append(f"   狀態：{item.status or '未分類'} | 互動：{item.visit_count or 1} 次")
                lines.append(f"   摘要：{(item.summary or '無')[:60]}")
            await self.line_client.reply_text(event.reply_token, "\n".join(lines))
            return WebhookProcessResult(processed=True, reason="command_memory")

        if lowered.startswith("/forget "):
            target_user_id = raw_text[8:].strip()
            deleted = self.user_memory_repository.delete_by_user_id(target_user_id)
            text = f"✅ 已清除 {target_user_id} 的記憶。" if deleted else f"ℹ️ 找不到 {target_user_id} 的記憶。"
            await self.line_client.reply_text(event.reply_token, text)
            return WebhookProcessResult(processed=True, reason="command_forget")

        if lowered == "/review":
            pending = self.learned_knowledge_repository.list_pending(limit=3)
            if not pending:
                await self.line_client.reply_text(event.reply_token, "✅ 目前沒有待審核的學習建議。")
                return WebhookProcessResult(processed=True, reason="command_review")
            lines = [f"📚 待審核的學習建議（{len(pending)} 筆）"]
            for item in pending:
                lines.append(f"【#{item.id}】{item.title or '無標題'}")
                lines.append(f"分類：{item.category or '未分類'}")
                lines.append(f"內容：{item.content[:100]}{'...' if len(item.content) > 100 else ''}")
            await self.line_client.reply_text(event.reply_token, "\n".join(lines))
            return WebhookProcessResult(processed=True, reason="command_review")

        if lowered.startswith("/approve "):
            try:
                knowledge_id = int(raw_text.split(maxsplit=1)[1].strip())
            except (IndexError, ValueError):
                await self.line_client.reply_text(event.reply_token, "❌ 格式錯誤，請用 /approve {id}")
                return WebhookProcessResult(processed=True, reason="command_approve_invalid")
            result = self.learned_knowledge_repository.review(
                knowledge_id=knowledge_id,
                action="approved",
                reviewer_id=user_id,
            )
            await self.line_client.reply_text(
                event.reply_token,
                f"✅ 學習建議 #{knowledge_id} 已通過！" if result else f"❌ 找不到 #{knowledge_id} 或已審核過。",
            )
            return WebhookProcessResult(processed=True, reason="command_approve")

        if lowered.startswith("/reject "):
            parts = raw_text.split()
            if len(parts) < 2:
                await self.line_client.reply_text(event.reply_token, "❌ 格式錯誤，請用 /reject {id} {原因}")
                return WebhookProcessResult(processed=True, reason="command_reject_invalid")
            try:
                knowledge_id = int(parts[1])
            except ValueError:
                await self.line_client.reply_text(event.reply_token, "❌ 格式錯誤，請用 /reject {id} {原因}")
                return WebhookProcessResult(processed=True, reason="command_reject_invalid")
            reason = raw_text.split(maxsplit=2)[2] if len(parts) >= 3 else None
            result = self.learned_knowledge_repository.review(
                knowledge_id=knowledge_id,
                action="rejected",
                reviewer_id=user_id,
                reject_reason=reason,
            )
            await self.line_client.reply_text(
                event.reply_token,
                f"❌ 學習建議 #{knowledge_id} 已拒絕。" if result else f"❌ 找不到 #{knowledge_id} 或已審核過。",
            )
            return WebhookProcessResult(processed=True, reason="command_reject")

        if lowered.startswith("/teach "):
            content = raw_text[7:].strip()
            if not content:
                await self.line_client.reply_text(event.reply_token, "❌ 請提供要教的內容\n格式：/teach {內容}")
                return WebhookProcessResult(processed=True, reason="command_teach_invalid")
            self.learned_knowledge_repository.create(
                source_type="owner_teach",
                source_chat_id=chat_id,
                source_message_ids=None,
                title=content[:50],
                content=content,
                category="其他",
                status="approved",
                reviewed_by=user_id,
            )
            await self.line_client.reply_text(event.reply_token, f"✅ 已學習！\n內容：{content[:100]}{'...' if len(content) > 100 else ''}")
            return WebhookProcessResult(processed=True, reason="command_teach")

        if lowered == "/reload-owner":
            try:
                owners = self.owner_config_service.reload_owner_user_ids()
            except OwnerConfigError as exc:
                await self.line_client.reply_text(event.reply_token, f"❌ owner 設定載入失敗：{exc}")
                return WebhookProcessResult(processed=True, reason="command_reload_owner_failed")
            await self.line_client.reply_text(event.reply_token, f"✅ owner 設定已重新載入：{', '.join(owners)}")
            return WebhookProcessResult(processed=True, reason="command_reload_owner")

        if lowered.startswith("/set-owner "):
            raw_owner_ids = raw_text[len("/set-owner "):].strip()
            owner_user_ids = [item.strip() for item in raw_owner_ids.split(",") if item.strip()]
            if not owner_user_ids:
                await self.line_client.reply_text(event.reply_token, "❌ 格式錯誤，請用 /set-owner <userId1,userId2,...>")
                return WebhookProcessResult(processed=True, reason="command_set_owner_invalid")
            owners = self.owner_config_service.set_owner_user_ids(owner_user_ids=owner_user_ids, actor_user_id=user_id)
            await self.line_client.reply_text(
                event.reply_token,
                "✅ owner 名單已更新。\n"
                f"目前 owner：{', '.join(owners)}\n"
                "注意：系統會強制保留下指令的操作者，避免誤把自己移除。",
            )
            return WebhookProcessResult(processed=True, reason="command_set_owner")

        if lowered == "/help":
            help_text = (
                "🤖 席爾克軟體智能助理\n\n"
                "可用指令：\n"
                "/help - 顯示指令說明\n"
                "/auto - 切換目前聊天室為自動回覆\n"
                "/manual - 切換目前聊天室為人工模式\n"
                "/status - 查看目前模式、owner 與待審核知識\n"
                "/memory - 查看目前使用者記憶摘要\n"
                "/forget {userId} - 清除指定使用者記憶\n"
                "/review - 查看待審核知識\n"
                "/approve {id} - 通過指定知識\n"
                "/reject {id} {原因} - 拒絕指定知識\n"
                "/teach {內容} - 手動新增知識\n"
                "/reload-owner - 重新載入 t_settings.owner_user_ids\n"
                "/set-owner <userId1,userId2,...> - 更新 owner 名單（限 owner 且限 1 對 1）"
            )
            await self.line_client.reply_text(event.reply_token, help_text)
            return WebhookProcessResult(processed=True, reason="command_help")

        return None

    def _is_bot_mentioned(self, event: LineWebhookEvent) -> bool:
        """群組 mention 判斷：優先讀 LINE mention payload，再 fallback 文字關鍵字。"""

        mentionees = (((event.message.mention or {}).get("mentionees")) if event.message else None) or []
        if mentionees:
            return True

        text = (event.message.text or "") if event.message else ""
        lowered = text.lower()
        mention_keywords = ["@席爾克軟體", "@席爾克", "@bot", "@客服"]
        return any(keyword.lower() in lowered for keyword in mention_keywords)


    def _is_auto_reply_enabled(self) -> bool:
        """從 t_settings 讀取 auto_reply_enabled 設定值，回傳是否啟用自動回覆。"""

        value = self.setting_repository.get_value("auto_reply_enabled")
        return value is not None and value.lower() in ("true", "1", "yes")

    def _build_fallback_reply(self, *, user_question: str | None, rag_results: list[dict]) -> str:
        """當 LLM 或 RAG 流程異常時，提供最小可用的 fallback 回覆。"""

        if rag_results:
            top = rag_results[0]
            source = top.get("source") or "知識庫"
            content = (top.get("content") or "").strip()
            snippet = content[:120] + ("..." if len(content) > 120 else "")
            return f"我先根據目前找到的資料為您整理：{snippet}\n\n如果您願意，我也可以再依您的實際需求進一步幫您細化。"

        question = (user_question or "您的問題").strip()
        return f"我已收到您想詢問的內容：{question}。\n目前我手上的資料不足以直接給您完整定論，建議再補充您想了解的重點，我再為您整理得更精準。"
