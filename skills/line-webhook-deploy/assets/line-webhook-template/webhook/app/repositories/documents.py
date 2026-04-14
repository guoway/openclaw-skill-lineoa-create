"""t_documents 資料存取層。"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.document import Document


class DocumentRepository:
    """封裝文件索引狀態存取邏輯。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_doc_id(self, doc_id: str) -> Document | None:
        """依 doc_id 取得文件紀錄。"""

        stmt = select(Document).where(Document.doc_id == doc_id).limit(1)
        return self.db.execute(stmt).scalar_one_or_none()

    def upsert_processing_record(
        self,
        *,
        doc_id: str,
        filename: str,
        file_path: str,
        file_type: str | None,
        file_size: int | None,
        content_hash: str,
        status: str,
        chunk_count: int = 0,
        error_message: str | None = None,
        indexed: bool = False,
    ) -> Document:
        """建立或更新文件索引狀態。"""

        record = self.get_by_doc_id(doc_id)
        if record is None:
            record = Document(doc_id=doc_id, filename=filename)
            self.db.add(record)

        record.filename = filename
        record.file_path = file_path
        record.file_type = file_type
        record.file_size = file_size
        record.content_hash = content_hash
        record.status = status
        record.chunk_count = chunk_count
        record.error_message = error_message
        record.indexed_at = datetime.now() if indexed else record.indexed_at
        self.db.flush()
        return record

    def delete_by_doc_id(self, doc_id: str) -> int:
        """刪除指定 doc_id 的文件狀態。"""

        record = self.get_by_doc_id(doc_id)
        if record is None:
            return 0
        self.db.delete(record)
        self.db.flush()
        return 1
