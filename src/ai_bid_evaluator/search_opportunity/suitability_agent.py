import math
from ai_bid_evaluator.search_opportunity.prompts.suitability_prompt import SUITABILITY_PROMPT
from ai_bid_evaluator.services.agent_client import AgentFactory

VALID_STATUS = ("适合投标", "不适合投标", "需人工复核")


class SuitabilityAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(
        self,
        candidate_id: str,
        tender_title: str,
        tender_url: str,
        source_name: str,
        published_date: str,
        company_profile: dict,
        announcement_extract: dict,
    ) -> dict:
        agent = self.factory.create_doc_agent(
            name="OpportunitySuitabilityAgent",
            instructions=SUITABILITY_PROMPT,
        )

        return await self.factory.run_doc_json(
            agent=agent,
            file_id=None,
            payload={
                "candidate_id": candidate_id,
                "tender_title": tender_title,
                "tender_url": tender_url,
                "source_name": source_name,
                "published_date": published_date,
                "company_profile": company_profile,
                "announcement_extract": announcement_extract,
                "task": "请评估该企业是否适合参与该招标项目投标。",
            },
        )


def normalize_suitability_result(result: dict, candidate_id: str) -> dict:
    """对适合性判定结果做兜底归一化（仿 score_utils 的防御式风格）。"""
    normalized = dict(result or {})

    status = str(normalized.get("suitability_status", "") or "").strip()
    aliases = {"适合": "适合投标", "推荐": "适合投标", "可行": "适合投标",
               "不适合": "不适合投标", "不推荐": "不适合投标", "不可行": "不适合投标",
               "不适合参与投标": "不适合投标"}
    normalized["suitability_status"] = status if status in VALID_STATUS else aliases.get(status, "需人工复核")

    try:
        score = float(normalized.get("suitability_score", 0) or 0)
    except (TypeError, ValueError):
        score = 0
    if not math.isfinite(score):
        score = 0
        normalized["suitability_status"] = "需人工复核"
    normalized["suitability_score"] = max(0, min(100, round(score)))

    assessments = normalized.get("requirement_assessments", [])
    if not isinstance(assessments, list):
        assessments = []
    normalized["requirement_assessments"] = assessments
    for item in assessments:
        if not isinstance(item, dict):
            continue
        matched = str(item.get("matched", "") or "")
        if matched not in ("matched", "partial", "mismatch", "unknown"):
            item["matched"] = "unknown"

    for key in ("strengths", "weaknesses", "key_factors", "manual_review_points"):
        value = normalized.get(key, [])
        if not isinstance(value, list):
            value = []
        normalized[key] = value

    if normalized.get("candidate_id", candidate_id) != candidate_id:
        raise ValueError("适合性结果 candidate_id 不匹配")
    normalized["candidate_id"] = candidate_id
    return normalized
