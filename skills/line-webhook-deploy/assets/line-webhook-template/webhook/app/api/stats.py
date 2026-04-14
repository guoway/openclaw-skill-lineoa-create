"""Stats API。"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require_internal_api_token
from app.db.session import get_db
from app.schemas.stats import StatsResponse
from app.services.stats_service import StatsService

router = APIRouter(tags=["stats"])


@router.get("/stats", response_model=StatsResponse)
def stats(
    _: None = Depends(require_internal_api_token),
    db: Session = Depends(get_db),
) -> StatsResponse:
    """提供訊息 / 使用者 / 自動回覆統計。"""

    service = StatsService(db)
    return service.build_response()
