"""Require both notice requirements and approved company sources for eligibility."""
from ai_bid_evaluator.workflows.contracts import verify_evidence, validate_profile_evidence


def validate_opportunity_qualification(result, profile, rules, company_documents, notice_document):
    validate_profile_evidence(profile, company_documents)
    verify_evidence(result.evidence, [notice_document] + company_documents)
    required = {}
    def visit(rule):
        if rule.kind == "qualification":
            required[rule.rule_id] = rule
        for child in rule.children:
            visit(child)
    for rule in rules:
        visit(rule)
    for rule in required.values():
        verify_evidence(rule.evidence, [notice_document])
    for check in result.checks:
        verify_evidence(check.evidence, company_documents)
    ids = [c.rule_id for c in result.checks]
    supported = (profile.confirmed and bool(profile.qualifications) and bool(required)
                 and len(set(ids)) == len(ids) and set(ids) == set(required)
                 and all(r.evidence for r in required.values()))
    if result.status == "suitable":
        supported = supported and all(c.status == "passed" and c.evidence for c in result.checks)
    elif result.status == "unsuitable":
        supported = supported and any(c.status == "failed" and required[c.rule_id].mandatory and c.evidence for c in result.checks)
    if result.status != "needs_review" and not supported:
        return result.model_copy(update={"status": "needs_review", "reasons": result.reasons + ["企业资格与公告要求的逐项证据不完整"]})
    return result
