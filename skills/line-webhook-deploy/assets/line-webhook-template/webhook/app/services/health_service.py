"""健康檢查服務。"""

from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.schemas.health import HealthResponse


class HealthService:
    """集中處理健康檢查所需的依賴探測。"""

    def __init__(self, settings: Settings, db: Session) -> None:
        self.settings = settings
        self.db = db

    def check_database(self) -> str:
        """檢查 MySQL 連線是否正常。"""

        self.db.execute(text("SELECT 1"))
        return "ok"

    def check_qdrant(self) -> str:
        """目前先回傳規劃中的狀態，待後續補實作。"""

        return "planned"

    def build_response(self) -> HealthResponse:
        """組合 `/health` API 回應內容。"""

        return HealthResponse(
            status="ok",
            app=self.settings.app_name,
            timestamp=datetime.now(),
            database=self.check_database(),
            qdrant=self.check_qdrant(),
        )
