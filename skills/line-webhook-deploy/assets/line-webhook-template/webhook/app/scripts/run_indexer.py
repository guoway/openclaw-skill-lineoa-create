"""手動執行 Python 版 indexer。"""

import argparse
import asyncio

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.indexer_service import IndexerService


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--watch", action="store_true", help="監看 knowledge 目錄變化")
    args = parser.parse_args()

    settings = get_settings()
    db = SessionLocal()
    try:
        service = IndexerService(settings=settings, db=db)
        results = await service.index_all()
        for item in results:
            print(f"{item.status}: {item.file_path} ({item.chunk_count} chunks)")
        if args.watch:
            print("watching knowledge directory...")
            await service.watch()
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
