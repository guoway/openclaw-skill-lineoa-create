"""FastAPI 應用程式進入點。"""

from fastapi import FastAPI
from sqlalchemy.orm import Session

from app.api.admin import router as admin_router
from app.api.health import router as health_router
from app.api.stats import router as stats_router
from app.api.webhook import router as webhook_router
from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.session import SessionLocal
from app.repositories.settings import SettingRepository
from app.repositories.users import UserRepository
from app.services.owner_config_service import OwnerConfigError, OwnerConfigService

setup_logging()
settings = get_settings()

app = FastAPI(
    title="line-webhook Python Version",
    version="0.1.0",
    debug=settings.app_debug,
)
app.include_router(health_router)
app.include_router(stats_router)
app.include_router(admin_router)
app.include_router(webhook_router)


@app.on_event("startup")
def validate_owner_settings_on_startup() -> None:
    """啟動時驗證 owner 設定存在。"""

    db: Session = SessionLocal()
    try:
        owner_config_service = OwnerConfigService(
            setting_repository=SettingRepository(db),
            user_repository=UserRepository(db),
        )
        owner_config_service.reload_owner_user_ids()
    except OwnerConfigError as exc:
        raise RuntimeError(f"Startup aborted: {exc}") from exc
    finally:
        db.close()


@app.get("/")
def root() -> dict[str, str]:
    """提供簡單的根路徑資訊，方便確認服務已啟動。"""

    return {
        "service": settings.app_name,
        "status": "starting-skeleton",
    }
