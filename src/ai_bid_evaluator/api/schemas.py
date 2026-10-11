from datetime import datetime
from typing import Generic, TypeVar, Literal
from pydantic import Field
from ai_bid_evaluator.domain.base import Contract, Identifier
from ai_bid_evaluator.domain.run import ProjectCreate, BidderCreate, RunCreate, RunResponse, ReviewDecision
from ai_bid_evaluator.domain.documents import EvidenceRef, DocumentChunk
from ai_bid_evaluator.domain.evaluation import QualificationResult, ScoreResult
from ai_bid_evaluator.domain.opportunity import CompanyProfile
from ai_bid_evaluator.domain.opportunity import TenderNotice, OpportunityAssessment


class ErrorBody(Contract):
    code: str
    message: str
    details: dict = Field(default_factory=dict)
    request_id: str


class ErrorResponse(Contract):
    error: ErrorBody


class HealthResponse(Contract):
    status: Literal["live", "ready"]
    model_configured: bool = False


class ProjectResponse(ProjectCreate):
    project_id: Identifier


class BidderResponse(BidderCreate):
    bidder_id: Identifier
    project_id: Identifier


class DocumentResponse(Contract):
    document_id: Identifier
    project_id: Identifier
    bidder_id: Identifier | None = None
    role: Literal["announcement", "tender", "bid", "profile"]
    status: Literal["ready", "needs_review", "failed"]
    document_hash: str
    diagnostics: list[str] = Field(default_factory=list)
    format: str
    parser: str
    chunk_count: int = Field(ge=0)


class VersionRequest(Contract):
    expected_version: int = Field(ge=1)


class EventResponse(Contract):
    seq: int
    event: str
    revision: int
    at: datetime
    details: dict = Field(default_factory=dict)


class ReviewItem(Contract):
    review_id: str
    kind: Literal["pending", "history"]
    target_id: Identifier
    revision: int
    payload: dict


class ReviewResponse(Contract):
    review_id: str
    run: RunResponse
    decision: Literal["confirm", "edit", "reject"]
    target_id: Identifier
    reason: str
    at: datetime


class EvaluationResponse(Contract):
    run_id: Identifier
    revision: int
    stale: bool
    confirmed: bool
    data: dict
    evidence_matrix: list[EvidenceRef]


class ReportResponse(Contract):
    report_id: str
    run_id: Identifier
    revision: int
    stale: bool
    confirmed: bool
    data: dict


T = TypeVar("T")
class Page(Contract, Generic[T]):
    items: list[T]
    next_cursor: str | None = None


PUBLIC_MODELS = [ProjectCreate, ProjectResponse, BidderCreate, BidderResponse, RunCreate, RunResponse,
                 ReviewDecision, DocumentResponse, DocumentChunk, EvidenceRef, QualificationResult, ScoreResult,
                 ErrorResponse, HealthResponse, Page[RunResponse], Page[DocumentChunk], TenderNotice, OpportunityAssessment]
