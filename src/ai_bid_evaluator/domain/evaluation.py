from typing import Literal
from pydantic import Field, model_validator
from .base import Contract, Identifier, NonNegativeDecimal, FiniteDecimal
from .documents import EvidenceRef

QualificationStatus = Literal["passed", "failed", "needs_review"]


class EvaluationRule(Contract):
    rule_id: Identifier
    title: str = Field(min_length=1)
    kind: Literal["qualification", "score"] = "score"
    mandatory: bool = True
    confirmed: bool = False
    max_score: NonNegativeDecimal = 0
    operation: Literal["manual", "fixed", "price_ratio"] = "manual"
    parameters: dict[str, NonNegativeDecimal] = Field(default_factory=dict)
    children: list["EvaluationRule"] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)


class QualificationCheck(Contract):
    rule_id: Identifier
    status: QualificationStatus = "needs_review"
    mandatory: bool = True
    evidence: list[EvidenceRef] = Field(default_factory=list)
    reason: str = ""

    @model_validator(mode="after")
    def require_evidence(self):
        if self.status == "passed" and not self.evidence:
            raise ValueError("通过资格须有证据")
        if self.status == "failed" and not self.evidence:
            object.__setattr__(self, "status", "needs_review")
        return self


class QualificationResult(Contract):
    bidder_id: Identifier
    bidder_name: str = ""
    status: QualificationStatus = "needs_review"
    checks: list[QualificationCheck] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def no_unproven_pass(self):
        if self.status == "failed" and not any(c.mandatory and c.status == "failed" and c.evidence for c in self.checks):
            object.__setattr__(self, "status", "needs_review")
        if self.status == "passed":
            if not self.checks or any(c.mandatory and c.status != "passed" for c in self.checks):
                raise ValueError("通过结论缺少逐项资格审查")
            if not self.evidence and not all(c.evidence for c in self.checks):
                raise ValueError("通过结论缺少证据")
        return self


class ScoreItem(Contract):
    rule_id: Identifier
    score: FiniteDecimal
    max_score: NonNegativeDecimal
    evidence: list[EvidenceRef] = Field(default_factory=list)
    inputs: dict[str, NonNegativeDecimal] = Field(default_factory=dict)


class ScoreResult(Contract):
    bidder_id: Identifier
    items: list[ScoreItem] = Field(default_factory=list)
    total_score: NonNegativeDecimal = 0
    max_total_score: NonNegativeDecimal = 0
    valid: bool = False
    errors: list[str] = Field(default_factory=list)
    reference_only: bool = False


def qualification_from_legacy(raw: dict, bidder_id: str) -> QualificationResult:
    if raw.get("bidder_id", bidder_id) != bidder_id:
        raise ValueError("资格结果 bidder_id 不匹配")
    checks = []
    for index, old in enumerate(raw.get("qualification_check", []), 1):
        evidence = old.get("evidence", [])
        status = "failed" if old.get("passed") is False else "needs_review"
        if old.get("passed") is True and evidence:
            status = "passed"
        checks.append(QualificationCheck(rule_id=str(old.get("id") or f"legacy_{index}"),
                                         status=status, evidence=evidence,
                                         mandatory=old.get("is_mandatory", True), reason=old.get("note", "")))
    status = "needs_review"
    if any(c.mandatory and c.status == "failed" for c in checks) or raw.get("all_passed") is False:
        status = "failed"
    elif checks and all(c.status == "passed" for c in checks) and raw.get("all_passed") is True:
        status = "passed"
    return QualificationResult(bidder_id=bidder_id, bidder_name=raw.get("bidder_name") or raw.get("document_info", {}).get("bidder", ""),
                               status=status, checks=checks)
