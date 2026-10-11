from datetime import datetime, timezone
from typing import Literal
from pydantic import ConfigDict, Field
from .base import Contract, Identifier
from .opportunity import OpportunityRequest

RunType = Literal["bid_evaluation", "opportunity_discovery"]
RunStatus = Literal["pending", "running", "awaiting_review", "succeeded", "failed", "cancelled"]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ProjectCreate(Contract):
    name: str = Field(min_length=1, max_length=200)


class BidderCreate(Contract):
    name: str = Field(min_length=1, max_length=200)


class RunCreate(Contract):
    type: RunType
    project_id: Identifier
    document_ids: list[Identifier] = Field(default_factory=list)
    company_id: Identifier | None = None
    company_revision: int | None = Field(default=None, ge=1)
    options: OpportunityRequest | None = None


class RunResponse(Contract):
    model_config = ConfigDict(extra="ignore", validate_assignment=True)
    run_id: Identifier
    type: RunType
    project_id: Identifier
    status: RunStatus = "pending"
    current_step: str | None = None
    completed_steps: list[str] = Field(default_factory=list)
    known_steps: list[str] = Field(default_factory=list)
    cancel_requested: bool = False
    review_count: int = Field(default=0, ge=0)
    revision: int = Field(default=1, ge=1)
    result_stale: bool = False
    error: dict | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class RunState(RunResponse):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)
    input_snapshot: dict = Field(default_factory=dict)
    owner: str | None = None
    lease_until: datetime | None = None


class ReviewDecision(Contract):
    decision: Literal["confirm", "edit", "reject"]
    target_id: Identifier
    patch: dict = Field(default_factory=dict)
    reason: str = Field(min_length=1, max_length=2000)
    actor: str = Field(default="local_user", min_length=1, max_length=100)
    expected_version: int = Field(ge=1)
