"""LINE Webhook API。"""

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.security import LineSignatureValidator
from app.db.session import get_db
from app.schemas.line_events import LineWebhookRequest
from app.schemas.webhook import WebhookAcceptedResponse
from app.services.webhook_service import WebhookService

router = APIRouter(tags=["webhook"])


@router.post("/webhook", response_model=WebhookAcceptedResponse)
async def receive_webhook(
    request: Request,
    x_line_signature: str | None = Header(default=None, alias="X-Line-Signature"),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> WebhookAcceptedResponse:
    """接收 LINE Webhook 並完成最小驗證與落庫。"""

    raw_body = await request.body()
    if not settings.line_channel_secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="LINE_CHANNEL_SECRET is not configured",
        )

    validator = LineSignatureValidator(settings.line_channel_secret)
    if not validator.validate(raw_body=raw_body, signature=x_line_signature):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")

    payload = LineWebhookRequest.model_validate_json(raw_body)
    service = WebhookService(settings=settings, db=db)

    for event in payload.events:
        await service.process_event(event)

    return WebhookAcceptedResponse(status="accepted", events=len(payload.events))
