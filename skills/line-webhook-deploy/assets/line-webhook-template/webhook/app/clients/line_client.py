"""LINE Messaging API client。"""

import logging
from typing import Any

import httpx

from app.core.config import Settings

logger = logging.getLogger(__name__)


class LineClient:
    """封裝 LINE Messaging API 所需的最小能力。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def reply_text(self, reply_token: str, text: str) -> None:
        """回覆單則純文字訊息。"""

        if not self.settings.line_channel_access_token:
            logger.warning("LINE channel access token is not configured; skip reply")
            return

        payload = {
            "replyToken": reply_token,
            "messages": [{"type": "text", "text": text}],
        }
        headers = {
            "Authorization": f"Bearer {self.settings.line_channel_access_token}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                "https://api.line.me/v2/bot/message/reply",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()

    async def get_user_profile(self, user_id: str) -> dict[str, Any] | None:
        """讀取 LINE 使用者 profile，若失敗則回傳 None。"""

        if not self.settings.line_channel_access_token:
            return None

        headers = {"Authorization": f"Bearer {self.settings.line_channel_access_token}"}
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"https://api.line.me/v2/bot/profile/{user_id}",
                headers=headers,
            )
            if response.is_success:
                return response.json()

        return None
