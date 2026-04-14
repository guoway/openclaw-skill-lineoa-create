"""SQLAlchemy Base 定義。"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """所有 ORM model 的共同基底類別。"""

    pass
