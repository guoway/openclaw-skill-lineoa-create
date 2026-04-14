"""Indexer healthcheck script。"""

from pathlib import Path

from app.core.config import get_settings


def main() -> int:
    settings = get_settings()
    knowledge_dir = Path(settings.knowledge_base_dir)
    return 0 if knowledge_dir.exists() else 1


if __name__ == "__main__":
    raise SystemExit(main())
