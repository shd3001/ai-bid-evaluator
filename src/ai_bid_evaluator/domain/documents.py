from typing import Literal
from pydantic import ConfigDict, Field, model_validator
from .base import Contract, Identifier


class DocumentInput(Contract):
    document_id: Identifier
    file_id: str | None = None
    text: str | None = None

    @model_validator(mode="after")
    def require_source(self):
        if not (self.file_id and self.file_id.strip()) and not (self.text and self.text.strip()):
            raise ValueError("文档没有可用 file_id 或正文")
        return self


class EvidenceRef(Contract):
    document_id: Identifier
    document_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    chunk_id: Identifier
    quote: str = Field(min_length=1)
    page: int | None = Field(default=None, ge=1)
    sheet: str | None = None
    row_start: int | None = Field(default=None, ge=1)
    row_end: int | None = Field(default=None, ge=1)
    column_start: int | None = Field(default=None, ge=1)
    column_end: int | None = Field(default=None, ge=1)


class DocumentChunk(Contract):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, str_strip_whitespace=False)
    document_id: Identifier
    chunk_id: Identifier
    text: str = Field(min_length=1)
    document_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    page: int | None = Field(default=None, ge=1)
    sheet: str | None = None
    row_start: int | None = Field(default=None, ge=1)
    row_end: int | None = Field(default=None, ge=1)
    column_start: int | None = Field(default=None, ge=1)
    column_end: int | None = Field(default=None, ge=1)
    quality: Literal["good", "needs_review"] = "good"

    def evidence(self, quote: str | None = None) -> EvidenceRef:
        excerpt = quote or self.text
        if excerpt not in self.text:
            raise ValueError("证据摘录不在文本块内")
        return EvidenceRef(**{k: v for k, v in self.model_dump().items() if k not in {"text", "quality"}}, quote=excerpt)


class ParsedDocument(Contract):
    document_id: Identifier
    document_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    format: str
    status: Literal["ready", "needs_review", "failed"]
    chunks: list[DocumentChunk] = Field(default_factory=list)
    diagnostics: list[str] = Field(default_factory=list)
    parser: str

    @property
    def text(self) -> str:
        return "\n\n".join(chunk.text for chunk in self.chunks)
