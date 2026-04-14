"""LINE Webhook event schemas。"""

from typing import Any, Literal

from pydantic import BaseModel, Field


class LineEventSource(BaseModel):
    """LINE event 來源資訊。"""

    type: str
    user_id: str | None = Field(default=None, alias="userId")
    group_id: str | None = Field(default=None, alias="groupId")
    room_id: str | None = Field(default=None, alias="roomId")


class LineMessagePayload(BaseModel):
    """LINE message payload。"""

    id: str | None = None
    type: str | None = None
    text: str | None = None
    quote_token: str | None = Field(default=None, alias="quoteToken")
    mention: dict[str, Any] | None = None


class LineWebhookEvent(BaseModel):
    """單一 LINE Webhook event。"""

    type: Literal["message", "follow", "unfollow", "join"] | str
    mode: str | None = None
    timestamp: int | None = None
    source: LineEventSource
    reply_token: str | None = Field(default=None, alias="replyToken")
    message: LineMessagePayload | None = None


class LineWebhookRequest(BaseModel):
    """LINE Webhook request body。"""

    destination: str | None = None
    events: list[LineWebhookEvent] = Field(default_factory=list)
