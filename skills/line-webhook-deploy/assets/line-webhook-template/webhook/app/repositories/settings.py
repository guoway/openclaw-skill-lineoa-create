"""t_settings 資料存取層。"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.setting import Setting


class SettingRepository:
    """封裝系統設定讀寫。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_value(self, setting_key: str) -> str | None:
        """取得單一 setting 值。"""

        stmt = select(Setting).where(Setting.setting_key == setting_key).limit(1)
        record = self.db.execute(stmt).scalar_one_or_none()
        return record.setting_value if record else None

    def set_value(self, *, setting_key: str, setting_value: str, description: str | None = None) -> Setting:
        """建立或更新 setting 值。"""

        stmt = select(Setting).where(Setting.setting_key == setting_key).limit(1)
        record = self.db.execute(stmt).scalar_one_or_none()
        if record is None:
            record = Setting(setting_key=setting_key, setting_value=setting_value, description=description)
            self.db.add(record)
        else:
            record.setting_value = setting_value
            if description is not None:
                record.description = description
        self.db.flush()
        return record
