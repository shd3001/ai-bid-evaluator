from ai_bid_evaluator.domain.evaluation import qualification_from_legacy, ScoreResult
from ai_bid_evaluator.reporting.bid_report import build_bid_report, merge_model_explanation
from ai_bid_evaluator.rules.qualification import index_by_bidder
from ai_bid_evaluator.utils.score_utils import normalize_score_result
from ai_bid_evaluator.rules.scoring import rules_from_legacy


class ReportAgent:
    def __init__(self, factory):
        self.factory = factory

    async def run(self, project_name, extracted_requirements, announcement_results, qualification_results, scoring_results):
        ids = [r["bidder_id"] for r in scoring_results]
        qs = index_by_bidder(qualification_results, ids)
        announcements = index_by_bidder(announcement_results, ids)
        qualifications, scores = [], []
        rules = rules_from_legacy(extracted_requirements.get("scoring_conditions", []), confirmed=True)
        for raw in scoring_results:
            bidder_id = raw["bidder_id"]
            q = qualification_from_legacy(qs[bidder_id], bidder_id)
            a = qualification_from_legacy(announcements[bidder_id], bidder_id)
            if a.status != "passed":
                status = "failed" if "failed" in (q.status, a.status) else "needs_review"
                q = q.model_copy(update={"status": status})
            qualifications.append(q)
            normalized = normalize_score_result(raw, rules)
            check = normalized["score_check"]
            scores.append(ScoreResult(bidder_id=bidder_id, total_score=normalized["total_score"],
                                       max_total_score=normalized["max_total_score"], valid=check["score_sum_valid"],
                                       errors=check["notes"] if not check["score_sum_valid"] else []))
        facts = build_bid_report(project_name, qualifications, scores)
        agent = self.factory.create_text_agent(name="BidReportExplanation",
            instructions="只输出 explanation 和 company_analysis（bidder_id、strengths、weaknesses）。不得修改资格、分值、排名、推荐。")
        explanation = await self.factory.run_text_json(agent=agent, payload={"facts": facts})
        return merge_model_explanation(facts, explanation)
