"""執行 DB-based memory jobs。"""

import argparse
import asyncio

from app.services.memory_job_runner import MemoryJobRunner


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--watch", action="store_true", help="持續輪詢執行 memory jobs")
    args = parser.parse_args()

    runner = MemoryJobRunner()
    if args.watch:
        await runner.watch()
    else:
        processed = await runner.run_once()
        print(f"processed={processed}")


if __name__ == "__main__":
    asyncio.run(main())
