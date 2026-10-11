from sqlalchemy import Boolean, Float, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class ProjectRow(Base):
    __tablename__ = "projects"
    project_id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)


class BidderRow(Base):
    __tablename__ = "bidders"
    bidder_id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.project_id"))
    name: Mapped[str] = mapped_column(String)


class CompanyRow(Base):
    __tablename__ = "companies"
    company_id: Mapped[str] = mapped_column(String, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)


class DocumentRow(Base):
    __tablename__ = "documents"
    document_id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.project_id"))
    bidder_id: Mapped[str | None] = mapped_column(ForeignKey("bidders.bidder_id"), nullable=True)
    role: Mapped[str] = mapped_column(String)
    data: Mapped[dict] = mapped_column(JSON)


class DocumentChunkRow(Base):
    __tablename__ = "document_chunks"
    chunk_id: Mapped[str] = mapped_column(String, primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.document_id"))
    data: Mapped[dict] = mapped_column(JSON)


class RunRow(Base):
    __tablename__ = "runs"
    run_id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.project_id"), index=True)
    type: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, index=True)
    owner: Mapped[str | None] = mapped_column(String, nullable=True)
    lease_until: Mapped[float | None] = mapped_column(Float, nullable=True)
    data: Mapped[dict] = mapped_column(JSON)


class RunStepRow(Base):
    __tablename__ = "run_steps"
    __table_args__ = (UniqueConstraint("run_id", "name"),)
    step_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.run_id"), index=True)
    name: Mapped[str] = mapped_column(String)
    data: Mapped[dict] = mapped_column(JSON)


class ReviewRow(Base):
    __tablename__ = "reviews"
    review_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.run_id"), index=True)
    data: Mapped[dict] = mapped_column(JSON)


class ReportRow(Base):
    __tablename__ = "reports"
    report_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.run_id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    stale: Mapped[bool] = mapped_column(Boolean, default=False)
    data: Mapped[dict] = mapped_column(JSON)


class EvaluationRow(Base):
    __tablename__ = "evaluations"
    evaluation_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.run_id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict] = mapped_column(JSON)


class EventRow(Base):
    __tablename__ = "run_events"
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.run_id"), index=True)
    data: Mapped[dict] = mapped_column(JSON)


class AuditRow(Base):
    __tablename__ = "audit_events"
    audit_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.run_id"), index=True)
    data: Mapped[dict] = mapped_column(JSON)


class IdempotencyRow(Base):
    __tablename__ = "idempotency_keys"
    scope: Mapped[str] = mapped_column(String, primary_key=True)
    key: Mapped[str] = mapped_column(String, primary_key=True)
    request_hash: Mapped[str] = mapped_column(String)
    response: Mapped[dict] = mapped_column(JSON)


class NoticeRow(Base):
    __tablename__ = "notices"
    notice_id: Mapped[str] = mapped_column(String, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)


class NoticeSourceRow(Base):
    __tablename__ = "notice_sources"
    source_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    notice_id: Mapped[str] = mapped_column(ForeignKey("notices.notice_id"))
    data: Mapped[dict] = mapped_column(JSON)


class ModelCacheRow(Base):
    __tablename__ = "model_cache"
    cache_key: Mapped[str] = mapped_column(String, primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)
