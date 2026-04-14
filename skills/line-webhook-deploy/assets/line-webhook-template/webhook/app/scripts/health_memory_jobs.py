"""Memory jobs healthcheck script。"""

from app.db.session import SessionLocal
from app.repositories.memory_jobs import MemoryJobRepository


def main() -> int:
    db = SessionLocal()
    try:
        repo = MemoryJobRepository(db)
        repo.list_due_jobs(now=__import__('datetime').datetime.now(), limit=1)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
