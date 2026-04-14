"""API 共用 dependency。"""

from fastapi import Depends, Header, HTTPException, status

from app.core.config import Settings, get_settings


async def require_internal_api_token(
    x_internal_api_token: str | None = Header(default=None, alias="X-Internal-Api-Token"),
    settings: Settings = Depends(get_settings),
) -> None:
    """保護 internal/admin API。"""

    expected_token = settings.internal_api_token
    if not expected_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="INTERNAL_API_TOKEN is not configured",
        )
    if x_internal_api_token != expected_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal API token",
        )
