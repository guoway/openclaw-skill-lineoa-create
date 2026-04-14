"""健康檢查回應 schema。"""

from datetime import datetime

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """定義 `/health` API 的回應格式。"""

    status: str
    app: str
    timestamp: datetime
    database: str
    qdrant: str
