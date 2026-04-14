"""Owner 設定快取與載入服務。"""

from __future__ import annotations

from app.repositories.settings import SettingRepository
from app.repositories.users import UserRepository


class OwnerConfigError(RuntimeError):
    """Owner 設定缺失或不合法。"""


class OwnerConfigService:
    """以 t_settings 作為 owner 單一真實來源。"""

    OWNER_SETTING_KEY = "owner_user_ids"

    def __init__(self, *, setting_repository: SettingRepository, user_repository: UserRepository) -> None:
        self.setting_repository = setting_repository
        self.user_repository = user_repository
        self._owner_user_ids: list[str] | None = None

    def get_owner_user_ids(self) -> list[str]:
        """讀取快取 owner ids；若未載入則從 DB 載入。"""

        if self._owner_user_ids is None:
            self.reload_owner_user_ids()
        return list(self._owner_user_ids or [])

    def reload_owner_user_ids(self) -> list[str]:
        """重新從 DB 載入 owner ids。"""

        raw_value = self.setting_repository.get_value(self.OWNER_SETTING_KEY)
        if raw_value is None or not raw_value.strip():
            raise OwnerConfigError("t_settings.owner_user_ids is missing")
        owner_user_ids = [item.strip() for item in raw_value.split(",") if item.strip()]
        if not owner_user_ids:
            raise OwnerConfigError("t_settings.owner_user_ids is empty")
        self._owner_user_ids = owner_user_ids
        return list(owner_user_ids)

    def set_owner_user_ids(self, *, owner_user_ids: list[str], actor_user_id: str) -> list[str]:
        """更新 DB 與快取中的 owner ids，並強制保留操作者。"""

        normalized = [item.strip() for item in owner_user_ids if item.strip()]
        if actor_user_id not in normalized:
            normalized.append(actor_user_id)
        deduped: list[str] = []
        seen: set[str] = set()
        for item in normalized:
            if item not in seen:
                seen.add(item)
                deduped.append(item)

        self.setting_repository.set_value(
            setting_key=self.OWNER_SETTING_KEY,
            setting_value=",".join(deduped),
            description="LINE owner user ids",
        )
        self.user_repository.sync_owner_flags(deduped)
        self._owner_user_ids = deduped
        return list(deduped)
