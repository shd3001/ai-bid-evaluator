from ai_bid_evaluator.domain.evaluation import QualificationResult, ScoreResult


def rank_bidders(qualifications: list[QualificationResult], scores: list[ScoreResult]) -> list[dict]:
    qs = {q.bidder_id: q for q in qualifications}
    ss = {s.bidder_id: s for s in scores}
    if len(qs) != len(qualifications) or len(ss) != len(scores) or set(qs) != set(ss):
        raise ValueError("资格与评分的投标人 ID 不一致或重复")
    ordered = sorted(scores, key=lambda s: (not (qs[s.bidder_id].status == "passed" and s.valid), -s.total_score, s.bidder_id))
    rows, position, last_score, rank = [], 0, None, None
    for score in ordered:
        q = qs[score.bidder_id]
        eligible = q.status == "passed" and score.valid
        if eligible:
            position += 1
            if score.total_score != last_score:
                rank = position
            last_score = score.total_score
        rows.append({"bidder_id": score.bidder_id, "bidder_name": q.bidder_name,
                     "qualification_status": q.status, "total_score": str(score.total_score),
                     "rank": rank if eligible else None, "recommended": eligible,
                     "reference_only": not eligible, "score_valid": score.valid,
                     "review_points": q.reasons + score.errors})
    return rows
