"""Conservative legacy JSON bridge; confirmed rules remain authoritative."""
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from ai_bid_evaluator.domain.evaluation import ScoreItem, ScoreResult
from ai_bid_evaluator.rules.scoring import validate_score_result


def normalize_score_result(scoring_result: dict, rules=None) -> dict:
    result = deepcopy(scoring_result)
    errors, items, seen = [], [], set()

    def visit(node):
        node_id = node.get("rule_id") or node.get("id")
        if not node_id or node_id in seen:
            errors.append("评分项 ID 缺失或重复")
        seen.add(node_id)
        children = node.get("children") or node.get("details") or []
        try:
            maximum = Decimal(str(node.get("max_score")))
            if children:
                values = [visit(c) for c in children]
                score = sum((v[0] for v in values), Decimal(0))
                if sum((v[1] for v in values), Decimal(0)) != maximum:
                    errors.append("父子满分冲突")
            else:
                score = Decimal(str(node.get("score")))
            if not score.is_finite() or not maximum.is_finite() or maximum < 0 or not 0 <= score <= maximum:
                raise ValueError("分值越界或非有限")
            node["score"] = float(score)
            if not children:
                items.append(ScoreItem(rule_id=str(node_id or "missing_id"), score=score, max_score=maximum))
            return score, maximum
        except (ValueError, TypeError, InvalidOperation):
            errors.append(f"无效分值 {node_id}")
            node["score"] = None
            return Decimal(0), Decimal(0)

    sums = [visit(i) for i in result.get("items", [])]
    if not sums:
        errors.append("没有评分项")
    if rules is not None and not errors:
        verified = validate_score_result(ScoreResult(bidder_id=result.get("bidder_id") or "legacy", items=items), rules)
        errors.extend(verified.errors)
        total, maximum = verified.total_score, verified.max_total_score
    else:
        total = sum((v[0] for v in sums), Decimal(0))
        maximum = sum((v[1] for v in sums), Decimal(0))
    result["total_score"], result["max_total_score"] = float(total), float(maximum)
    result["score_check"] = {"score_sum_valid": not errors, "max_score_sum_valid": not errors,
                             "calculated_total_score": float(total), "calculated_max_total_score": float(maximum),
                             "rules_verified": rules is not None, "notes": errors or ["总分由程序重新计算"]}
    return result
