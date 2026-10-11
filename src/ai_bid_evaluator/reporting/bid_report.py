from copy import deepcopy
from ai_bid_evaluator.domain.evaluation import QualificationResult, ScoreResult
from ai_bid_evaluator.rules.ranking import rank_bidders


def build_bid_report(project_name: str, qualifications: list[QualificationResult], scores: list[ScoreResult]) -> dict:
    ranking = rank_bidders(qualifications, scores)
    review = [row for row in ranking if row["qualification_status"] == "needs_review" or not row["score_valid"]]
    return {"project_name": project_name, "ranking": ranking,
            "bidders": [s.model_dump(mode="json") for s in scores],
            "qualification_results": [q.model_dump(mode="json") for q in qualifications],
            "disqualified_bidders": [row for row in ranking if row["qualification_status"] == "failed"],
            "manual_review_points": review, "confirmed": not review,
            "final_conclusion": "需人工复核" if review else "按确认规则生成辅助评审结果"}


def merge_model_explanation(facts: dict, model_result: dict) -> dict:
    allowed = {"explanation", "company_analysis"}
    for key, value in model_result.items():
        if key not in allowed and (key not in facts or value != facts[key]):
            raise ValueError(f"模型试图修改报告事实: {key}")
    known = {row["bidder_id"] for row in facts.get("ranking", [])}
    for row in model_result.get("company_analysis", []):
        if row.get("bidder_id") not in known or set(row) - {"bidder_id", "strengths", "weaknesses", "explanation"}:
            raise ValueError("模型分析含未知 ID 或事实字段")
    report = deepcopy(facts)
    for key in allowed:
        if key in model_result:
            report[key] = model_result[key]
    return report
