from decimal import Decimal
from ai_bid_evaluator.domain.evaluation import EvaluationRule, ScoreResult, ScoreItem


def scoring_leaves(rules: list[EvaluationRule]) -> tuple[dict[str, EvaluationRule], list[str]]:
    leaves, errors, seen = {}, [], set()
    def visit(rule):
        if rule.rule_id in seen:
            errors.append(f"重复规则 {rule.rule_id}")
        seen.add(rule.rule_id)
        if not rule.confirmed:
            errors.append(f"规则未确认 {rule.rule_id}")
        if rule.children:
            if sum((r.max_score for r in rule.children), Decimal(0)) != rule.max_score:
                errors.append(f"父子满分不一致 {rule.rule_id}")
            for child in rule.children:
                visit(child)
        else:
            leaves[rule.rule_id] = rule
    for r in rules:
        if r.kind == "score":
            visit(r)
    if not leaves:
        errors.append("没有可用评分规则")
    return leaves, errors


def validate_score_result(result: ScoreResult, rules: list[EvaluationRule]) -> ScoreResult:
    leaves, errors = scoring_leaves(rules)
    ids = [i.rule_id for i in result.items]
    if len(set(ids)) != len(ids):
        errors.append("重复评分项")
    if set(ids) != set(leaves):
        errors.append("评分项缺失或包含未知 ID")
    verified = []
    for item in result.items:
        rule = leaves.get(item.rule_id)
        if rule is None:
            continue
        score = item.score
        if item.max_score != rule.max_score:
            errors.append(f"满分与规则不一致 {item.rule_id}")
        if rule.operation == "price_ratio":
            base, bid = rule.parameters.get("base_price"), item.inputs.get("bid_price")
            if base is None or bid is None or base <= 0 or bid <= 0 or not item.evidence:
                errors.append(f"价格参数缺失或无效 {item.rule_id}")
            else:
                score = min(rule.max_score, rule.max_score * base / bid).quantize(Decimal("0.01"))
        elif rule.operation == "fixed":
            if "score" not in rule.parameters:
                errors.append(f"固定分值参数缺失 {item.rule_id}")
            else:
                score = rule.parameters["score"]
        if not score.is_finite() or not 0 <= score <= rule.max_score:
            errors.append(f"评分越界 {item.rule_id}")
        verified.append(ScoreItem(rule_id=item.rule_id, score=score, max_score=rule.max_score, evidence=item.evidence, inputs=item.inputs))
    return ScoreResult(bidder_id=result.bidder_id, items=verified,
                       total_score=max(Decimal(0), sum((i.score for i in verified), Decimal(0))),
                       max_total_score=sum((r.max_score for r in leaves.values()), Decimal(0)),
                       valid=not errors, errors=errors, reference_only=result.reference_only)


def rules_from_legacy(items: list[dict], *, confirmed: bool = False) -> list[EvaluationRule]:
    def convert(item):
        return EvaluationRule(rule_id=str(item.get("rule_id") or item.get("id") or "missing_id"),
                              title=item.get("title") or item.get("name") or "评分项",
                              max_score=item.get("max_score", 0), confirmed=confirmed,
                              children=[convert(c) for c in (item.get("children") or item.get("details") or [])])
    return [convert(i) for i in items]
