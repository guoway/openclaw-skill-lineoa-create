"""t_users 資料存取層。"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models.user import User


class UserRepository:
    """封裝使用者主檔的查詢與 upsert。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_user_id(self, user_id: str) -> User | None:
        """依 LINE user id 取得使用者資料。"""

        stmt = select(User).where(User.user_id == user_id)
        return self.db.execute(stmt).scalar_one_or_none()

    def upsert_basic_profile(
        self,
        user_id: str,
        display_name: str | None,
        picture_url: str | None,
        status_message: str | None,
        is_owner: bool,
    ) -> User:
        """建立或更新使用者主檔基本資料。"""

        user = self.get_by_user_id(user_id)
        if user is None:
            user = User(
                user_id=user_id,
                display_name=display_name,
                picture_url=picture_url,
                status_message=status_message,
                is_owner=is_owner,
            )
            self.db.add(user)
        else:
            user.display_name = display_name
            user.picture_url = picture_url
            user.status_message = status_message
            user.is_owner = is_owner

        self.db.flush()
        return user

    def count_all(self) -> int:
        """取得用戶總數。"""

        stmt = select(func.count()).select_from(User)
        return int(self.db.execute(stmt).scalar_one())

    def sync_owner_flags(self, owner_user_ids: list[str]) -> None:
        """同步 t_users.is_owner。"""

        all_users = list(self.db.execute(select(User)).scalars().all())
        owner_set = set(owner_user_ids)
        for user in all_users:
            user.is_owner = user.user_id in owner_set
        self.db.flush()
