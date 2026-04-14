"""統計服務。"""

from datetime import datetime

from sqlalchemy.orm import Session

from app.repositories.auto_replies import AutoReplyRepository
from app.repositories.messages import MessageRepository
from app.repositories.users import UserRepository
from app.schemas.stats import StatsResponse


class StatsService:
    """集中處理統計資料組裝。"""

    def __init__(self, db: Session) -> None:
        self.message_repository = MessageRepository(db)
        self.user_repository = UserRepository(db)
        self.auto_reply_repository = AutoReplyRepository(db)

    def build_response(self) -> StatsResponse:
        """組合 stats 回應。"""

        return StatsResponse(
            messages=self.message_repository.count_all(),
            users=self.user_repository.count_all(),
            auto_replies=self.auto_reply_repository.count_all(),
            timestamp=datetime.now(),
        )
