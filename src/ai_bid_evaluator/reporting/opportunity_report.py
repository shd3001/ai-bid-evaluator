from ai_bid_evaluator.search_opportunity.suitability_agent import normalize_suitability_result
from decimal import Decimal, InvalidOperation


def build_opportunity_report(candidates: list[dict], assessments: list[dict]) -> dict:
    by_id = {}
    known = {c["candidate_id"] for c in candidates}
    if len(known) != len(candidates):
        raise ValueError("重复候选 ID")
    for a in assessments:
        cid = a.get("candidate_id")
        if cid not in known or cid in by_id:
            raise ValueError("未知或重复候选结果 ID")
        by_id[cid] = normalize_suitability_result(a, cid)
        try:
            exact = Decimal(str(a.get("suitability_score", "0")))
            if not exact.is_finite():
                raise ValueError()
            by_id[cid]["suitability_score"] = str(max(Decimal(0), min(Decimal(100), exact)))
        except (ValueError, InvalidOperation):
            by_id[cid]["suitability_score"] = "0"
            by_id[cid]["suitability_status"] = "需人工复核"
    rows = []
    for c in candidates:
        cid = c["candidate_id"]
        result = by_id.get(cid) or normalize_suitability_result(c.get("suitability") or {}, cid)
        rows.append({"candidate_id": cid, "title": c.get("title", ""), "url": c.get("url", ""), **result})
    for row in rows:
        row["suitability_score"] = str(row["suitability_score"])
    rows.sort(key=lambda r: (-Decimal(r["suitability_score"]), r["candidate_id"]))
    return {"opportunity_ranking": rows,
            "recommended_opportunities": [r for r in rows if r["suitability_status"] == "适合投标"],
            "not_recommended": [r for r in rows if r["suitability_status"] == "不适合投标"],
            "manual_review": [r for r in rows if r["suitability_status"] == "需人工复核"]}
