"""Logging 設定模組。"""

import logging
import sys
from typing import Any


LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"


def setup_logging(level: int = logging.INFO) -> None:
    """初始化全域 logging 設定。"""

    root_logger = logging.getLogger()
    if root_logger.handlers:
        return

    logging.basicConfig(
        level=level,
        format=LOG_FORMAT,
        stream=sys.stdout,
    )


def get_logger(name: str) -> logging.Logger:
    """取得模組 logger。"""

    return logging.getLogger(name)


def format_log_context(**kwargs: Any) -> str:
    """將結構化欄位轉為統一 log context 字串。"""

    parts = []
    for key, value in kwargs.items():
        if value is None:
            continue
        parts.append(f"{key}={value}")
    return " | ".join(parts)
