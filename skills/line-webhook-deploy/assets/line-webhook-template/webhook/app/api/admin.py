"""Admin API。"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require_internal_api_token
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.schemas.admin import AnalyzeStyleResponse
from app.services.admin_service import AdminService

router = APIRouter(tags=["admin"])


@router.post("/admin/analyze-style", response_model=AnalyzeStyleResponse)
async def analyze_style(
    _: None = Depends(require_internal_api_token),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AnalyzeStyleResponse:
    """手動觸發 owner style analysis。"""

    service = AdminService(settings=settings, db=db)
    return await service.analyze_owner_styles()
