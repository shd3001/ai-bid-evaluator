from ai_bid_evaluator.domain.evaluation import QualificationResult, QualificationCheck, EvaluationRule


def index_by_bidder(results: list[dict], expected_ids: list[str]) -> dict[str, dict]:
    indexed = {}
    for result in results:
        bidder_id = result.get("bidder_id")
        if not bidder_id or bidder_id in indexed or bidder_id not in expected_ids:
            raise ValueError("资格结果缺少 ID、有重复 ID 或含未知 ID")
        indexed[bidder_id] = result
    if set(indexed) != set(expected_ids):
        raise ValueError("资格结果缺少投标人，禁止继续")
    return indexed


def evaluate_qualification(bidder_id: str, checks: list[QualificationCheck], rules: list[EvaluationRule]) -> QualificationResult:
    expected = {r.rule_id: r for r in rules if r.kind == "qualification"}
    actual = {c.rule_id: c for c in checks}
    reasons = []
    status = "needs_review"
    if not expected or len(actual) != len(checks) or set(expected) != set(actual) or any(not r.confirmed for r in expected.values()):
        reasons.append("资格规则未确认或审查项不完整")
    elif any(expected[c.rule_id].mandatory and c.status == "failed" for c in checks):
        status = "failed"
    elif all(c.status == "passed" for c in checks):
        status = "passed"
    verified = [c.model_copy(update={"mandatory": expected[c.rule_id].mandatory}) if c.rule_id in expected else c for c in checks]
    return QualificationResult(bidder_id=bidder_id, checks=verified, status=status, reasons=reasons)
