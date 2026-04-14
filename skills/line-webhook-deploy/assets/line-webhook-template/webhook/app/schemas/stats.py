"""Stats API schemas。"""

from datetime import datetime

from pydantic import BaseModel


class StatsResponse(BaseModel):
    """系統統計回應。"""

    messages: int
    users: int
    auto_replies: int
    timestamp: datetime
