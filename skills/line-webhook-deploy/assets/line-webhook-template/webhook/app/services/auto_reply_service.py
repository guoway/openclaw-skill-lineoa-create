"""Auto reply 決策服務。"""

from app.schemas.auto_reply import AutoReplyDecision


class AutoReplyDecisionService:
    """封裝是否應由 AI 自動回覆的判斷規則。"""

    def __init__(self, *, owner_user_ids_provider, auto_reply_keywords: list[str], owner_response_timeout: int) -> None:
        self.owner_user_ids_provider = owner_user_ids_provider
        self.auto_reply_keywords = auto_reply_keywords
        self.owner_response_timeout = owner_response_timeout

    def is_owner(self, user_id: str | None) -> bool:
        """判斷使用者是否為 owner。"""

        return bool(user_id and user_id in self.owner_user_ids_provider())

    def decide(
        self,
        *,
        user_id: str | None,
        chat_type: str,
        chat_mode: str,
        message_text: str | None,
        bot_mentioned: bool,
        owner_replied_recently: bool,
    ) -> AutoReplyDecision:
        """依現有規則輸出第一版 auto-reply decision。"""

        if self.is_owner(user_id):
            return AutoReplyDecision(should_reply=False, reason="owner_message")

        normalized_text = (message_text or "").strip()

        if chat_type in {"group", "room"}:
            if not bot_mentioned:
                return AutoReplyDecision(should_reply=False, reason="not_mentioned_in_group")
            return AutoReplyDecision(should_reply=True, reason="mentioned_in_group")

        if chat_mode == "manual":
            return AutoReplyDecision(should_reply=False, reason="manual_mode")

        if owner_replied_recently:
            return AutoReplyDecision(should_reply=False, reason="owner_replied_recently")

        trigger_keyword = self._find_trigger_keyword(normalized_text)
        return AutoReplyDecision(
            should_reply=True,
            reason="auto_mode",
            trigger_keyword=trigger_keyword,
        )

    def _find_trigger_keyword(self, message_text: str) -> str | None:
        """找出命中的觸發關鍵字。"""

        if not message_text:
            return None

        lowered = message_text.lower()
        for keyword in self.auto_reply_keywords:
            normalized_keyword = keyword.strip()
            if normalized_keyword and normalized_keyword.lower() in lowered:
                return normalized_keyword
        return None
