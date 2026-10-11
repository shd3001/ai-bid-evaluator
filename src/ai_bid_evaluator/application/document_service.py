from pathlib import Path
from uuid import uuid4
from sqlalchemy import select
from ai_bid_evaluator.domain.exceptions import DomainError, NotFound, UnsupportedFormat
from ai_bid_evaluator.infrastructure.orm_models import ProjectRow, BidderRow, DocumentRow, DocumentChunkRow
from ai_bid_evaluator.services.document_ingestion import ingest_document, SUPPORTED_FORMATS


class UploadTooLarge(DomainError):
    code = "upload_too_large"
    http_status = 413


def document_response(row):
    return {"document_id": row.document_id, "project_id": row.project_id, "bidder_id": row.bidder_id,
            "role": row.role, "status": row.data["status"], "document_hash": row.data["document_hash"],
            "diagnostics": row.data["diagnostics"], "format": row.data["format"], "parser": row.data["parser"],
            "chunk_count": len(row.data["chunks"])}


class DocumentService:
    def __init__(self, repository, root, limit):
        self.repository, self.root, self.limit = repository, Path(root), limit

    def _validate(self, session, project_id, role, bidder_id):
        if session.get(ProjectRow, project_id) is None:
            raise NotFound("项目不存在")
        if (role == "bid") != (bidder_id is not None):
            raise DomainError("只有投标材料需要且必须关联 bidder_id")
        if bidder_id:
            bidder = session.get(BidderRow, bidder_id)
            if bidder is None or bidder.project_id != project_id:
                raise DomainError("投标人与项目不匹配")

    def upload(self, source, filename, project_id, role, bidder_id=None):
        if not filename or any(c in filename for c in ("/", "\\", ":")) or filename in {".", ".."}:
            raise DomainError("文件名不合法")
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED_FORMATS:
            raise UnsupportedFormat("文件格式没有已验证的解析器")
        with self.repository.db.read() as session:
            self._validate(session, project_id, role, bidder_id)
        document_id = f"doc_{uuid4().hex}"
        directory = self.root / "data" / "documents"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{document_id}{suffix}"
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise DomainError("文档存储目录不合法")
        keep = False
        try:
            total = 0
            with path.open("xb") as out:
                while chunk := source.read(65536):
                    total += len(chunk)
                    if total > self.limit:
                        raise UploadTooLarge("上传文件超过大小限制")
                    out.write(chunk)
            parsed = ingest_document(path, document_id)
            if parsed.status == "failed":
                raise DomainError("材料无法解析或正文为空", {"diagnostics": parsed.diagnostics})
            with self.repository.db.write() as session:
                self._validate(session, project_id, role, bidder_id)
                rows = session.scalars(select(DocumentRow).where(DocumentRow.project_id == project_id,
                                       DocumentRow.role == role, DocumentRow.bidder_id == bidder_id))
                for row in rows:
                    if row.data["document_hash"] == parsed.document_hash and row.data["format"] == parsed.format:
                        return document_response(row)
                row = DocumentRow(document_id=document_id, project_id=project_id, role=role,
                                  bidder_id=bidder_id, data=parsed.model_dump(mode="json"))
                session.add(row)
                session.flush()
                for chunk in parsed.chunks:
                    session.add(DocumentChunkRow(chunk_id=chunk.chunk_id, document_id=document_id, data=chunk.model_dump(mode="json")))
                result = document_response(row)
            keep = True
            return result
        finally:
            if not keep:
                path.unlink(missing_ok=True)
