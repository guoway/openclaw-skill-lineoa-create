"""Webhook API schemas。"""

from pydantic import BaseModel


class WebhookAcceptedResponse(BaseModel):
    """Webhook 接收成功的最小回應格式。"""

    status: str
    events: int
