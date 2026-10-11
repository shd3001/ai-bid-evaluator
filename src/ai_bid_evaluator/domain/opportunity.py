from datetime import datetime
from typing import Literal
from pydantic import Field, model_validator, field_validator
from .base import Contract, Identifier, NonNegativeDecimal
from .documents import EvidenceRef
from .evaluation import QualificationCheck


class CompanyProfile(Contract):
    company_id: Identifier
    name: str
    revision: int = Field(default=1, ge=1)
    confirmed: bool = False
    industry: str = ""
    qualifications: list[str] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)


class TenderNotice(Contract):
    notice_id: Identifier
    title: str
    url: str
    notice_type: Literal["tender", "award", "correction", "termination", "unknown"] = "unknown"
    deadline: datetime | None = None
    budget: NonNegativeDecimal | None = None
    region: str | None = None
    providers: list[str] = Field(default_factory=list)
    project_number: str | None = None
    lot_id: str | None = None
    related_notice_id: Identifier | None = None
    evidence: list[EvidenceRef] = Field(default_factory=list)
    diagnostics: list[str] = Field(default_factory=list)

    @field_validator("deadline")
    @classmethod
    def aware_deadline(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError("截止时间必须包含时区")
        return value


class OpportunityRequest(Contract):
    queries: list[str] = Field(default_factory=list)
    regions: list[str] = Field(default_factory=list)
    min_budget: NonNegativeDecimal | None = None
    max_budget: NonNegativeDecimal | None = None
    max_candidates: int = Field(default=5, ge=1, le=100)

    @model_validator(mode="after")
    def budget_range(self):
        if self.min_budget is not None and self.max_budget is not None and self.min_budget > self.max_budget:
            raise ValueError("预算下限不得超过上限")
        return self


class OpportunityAssessment(Contract):
    candidate_id: Identifier
    status: Literal["suitable", "unsuitable", "needs_review"] = "needs_review"
    score: NonNegativeDecimal = Field(default=0, le=100)
    reasons: list[str] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    checks: list[QualificationCheck] = Field(default_factory=list)
