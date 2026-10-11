from __future__ import annotations

from typing import Any

from ai_bid_evaluator.search_opportunity.prompts.report_prompt import OPPORTUNITY_REPORT_PROMPT
from ai_bid_evaluator.services.agent_client import AgentFactory
from ai_bid_evaluator.reporting.opportunity_report import build_opportunity_report


class OpportunityReportAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(
        self,
        company_profile: dict,
        candidates: list[dict],
        suitability_results: list[dict],
    ) -> dict:
        report = build_opportunity_report(candidates, suitability_results)
        report["company_profile_summary"] = company_profile.get("company_name", "")
        report["final_conclusion"] = "根据逐项评估生成；需复核项目不得直接推荐。"
        return report


def generate_opportunity_markdown(report: dict, candidates: list[dict], suitability_results: list[dict]) -> str:
    """把汇总报告转成可读 Markdown（仿 scoring_text_generator 风格）。"""
    lines: list[str] = []

    lines.append("投标机会评估报告")
    lines.append("=" * 60)
    lines.append("")

    profile_summary = report.get("company_profile_summary", "")
    if profile_summary:
        lines.append(f"企业画像：{profile_summary}")
        lines.append("")

    summary = report.get("opportunity_summary", "")
    if summary:
        lines.append(f"机会概况：{summary}")
        lines.append("")

    ranking = report.get("opportunity_ranking", [])
    if ranking:
        lines.append("一、机会排名")
        lines.append("-" * 60)
        for rank, item in enumerate(ranking, start=1):
            if not isinstance(item, dict):
                continue
            lines.append(f"{rank}. {item.get('title', '')}")
            lines.append(f"   判定：{item.get('suitability_status', '')}（{item.get('suitability_score', '')} 分）")
            reason = item.get("reason", "")
            if reason:
                lines.append(f"   理由：{reason}")
            lines.append("")

    _append_section(lines, "二、建议投报的机会", report.get("recommended_opportunities", []), ["key_reasons"])
    _append_section(lines, "三、不建议投报的机会", report.get("not_recommended", []), ["reasons"])
    _append_section(lines, "四、需人工复核的机会", report.get("manual_review", []), ["review_points"])

    conclusion = report.get("final_conclusion", "")
    if conclusion:
        lines.append("五、总体建议")
        lines.append("-" * 60)
        lines.append(conclusion)
        lines.append("")

    # 附：各机会适合性判定明细
    lines.append("附：各机会适合性判定明细")
    lines.append("-" * 60)
    by_id = {str(r.get("candidate_id", "")): r for r in suitability_results if isinstance(r, dict)}
    if not by_id:
        lines.append("（无有效判定结果）")
    for candidate in candidates:
        cid = str(candidate.get("candidate_id", ""))
        result = by_id.get(cid)
        if not result:
            continue
        status = result.get("suitability_status", "")
        score = result.get("suitability_score", "")
        lines.append("")
        lines.append(f"{cid} | {candidate.get('title', '')}")
        lines.append(f"    判定：{status}（{score} 分） | 来源：{candidate.get('source_name', '')}")
        reason = result.get("recommendation_reason", "")
        if reason:
            lines.append(f"    结论理由：{reason}")
        strengths = result.get("strengths", [])
        if strengths:
            lines.append(f"    优势：{'；'.join(str(s) for s in strengths)}")
        weaknesses = result.get("weaknesses", [])
        if weaknesses:
            lines.append(f"    不足：{'；'.join(str(w) for w in weaknesses)}")

    return "\n".join(lines)


def _append_section(lines: list[str], title: str, items: list[Any], detail_keys: list[str]) -> None:
    lines.append(title)
    lines.append("-" * 60)
    if not items:
        lines.append("（无）")
    for item in items:
        if not isinstance(item, dict):
            continue
        lines.append(f"- {item.get('title', item.get('candidate_id', ''))}")
        for key in detail_keys:
            details = item.get(key, [])
            if details:
                lines.append(f"    - {'；'.join(str(d) for d in details)}")
        url = item.get("url", "")
        if url:
            lines.append(f"    链接：{url}")
    lines.append("")
