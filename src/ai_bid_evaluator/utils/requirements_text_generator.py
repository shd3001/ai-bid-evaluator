from pathlib import Path
from typing import Any

from ai_bid_evaluator.utils.json_utils import save_text_from_json


def generate_extracted_requirements_text(data: dict[str, Any]) -> str:
    lines = []

    document_info = data.get("document_info", {})
    project_name = (
        document_info.get("project_name")
        or document_info.get("title")
        or "未识别项目名称"
    )

    lines.append("招标文件评审标准提取结果说明")
    lines.append("=" * 60)
    lines.append(f"项目名称：{project_name}")
    lines.append(f"项目编号：{document_info.get('project_number', '未提取')}")
    lines.append(f"招标人：{document_info.get('tenderer', '未提取')}")
    lines.append(f"招标代理：{document_info.get('tender_agency', '未提取')}")
    lines.append(f"评标办法：{document_info.get('review_method', '未提取')}")

    total_score = (
        data.get("summary", {}).get("scoring_total_score")
        or document_info.get("total_score")
        or "未提取"
    )
    lines.append(f"评分总分：{total_score}")
    lines.append("")

    append_qualification_standards(
        lines,
        data.get("qualification_review_standards")
        or data.get("qualification_requirements", []),
    )

    append_scoring_conditions(
        lines,
        data.get("scoring_conditions")
        or data.get("items", []),
    )

    append_disqualification_rules(
        lines,
        data.get("disqualification_rules", []),
    )

    append_manual_review_points(
        lines,
        data.get("manual_review_points", []),
    )

    append_summary(lines, data.get("summary", {}))

    return "\n".join(lines)


def append_qualification_standards(lines: list[str], standards: list[dict[str, Any]]) -> None:
    lines.append("一、资格评审标准")
    lines.append("-" * 60)

    if not standards:
        lines.append("未提取到资格评审标准。")
        lines.append("")
        return

    for index, item in enumerate(standards, start=1):
        lines.append(f"{index}. {item.get('title', '未命名资格项')}")
        lines.append(f"   编号：{item.get('id', '')}")
        lines.append(f"   类别：{item.get('category', '')}")
        lines.append(f"   是否强制：{'是' if item.get('mandatory', True) else '否'}")
        lines.append(f"   评审方式：{item.get('review_result_type', '通过/不通过')}")

        if item.get("description"):
            lines.append(f"   要求说明：{item['description']}")

        if item.get("pass_condition"):
            lines.append(f"   通过条件：{item['pass_condition']}")

        if item.get("fail_consequence"):
            lines.append(f"   不满足后果：{item['fail_consequence']}")

        if item.get("evidence_keywords"):
            keywords_str = "、".join(item["evidence_keywords"])
            lines.append(f"   证据关键词：{keywords_str}")

        if item.get("original_text"):
            lines.append(f"   原文依据：{item['original_text']}")

        lines.append("")


def append_scoring_conditions(lines: list[str], conditions: list[dict[str, Any]]) -> None:
    lines.append("二、评审因素与评分标准")
    lines.append("-" * 60)

    if not conditions:
        lines.append("未提取到评审因素与评分标准。")
        lines.append("")
        return

    for index, item in enumerate(conditions, start=1):
        append_scoring_item(lines, item, str(index), "")


def append_scoring_item(
    lines: list[str],
    item: dict[str, Any],
    number: str,
    indent: str,
) -> None:
    title = item.get("title") or item.get("name") or "未命名评分项"

    lines.append(f"{indent}{number}. {title}")
    lines.append(f"{indent}   编号：{item.get('id', '')}")
    lines.append(f"{indent}   类别：{item.get('category', '')}")
    lines.append(f"{indent}   满分：{item.get('max_score', 0)} 分")

    if item.get("description"):
        lines.append(f"{indent}   说明：{item['description']}")

    if item.get("scoring_rule"):
        lines.append(f"{indent}   评分规则：{item['scoring_rule']}")

    if item.get("original_text"):
        lines.append(f"{indent}   原文依据：{item['original_text']}")

    children = item.get("children", [])
    details = item.get("details", [])

    for child_index, child in enumerate(children, start=1):
        append_scoring_item(lines, child, f"{number}.{child_index}", indent + "   ")

    for detail_index, detail in enumerate(details, start=1):
        append_scoring_item(lines, detail, f"{number}.{detail_index}", indent + "   ")

    lines.append("")


def append_disqualification_rules(lines: list[str], rules: list[dict[str, Any]]) -> None:
    lines.append("三、否决投标 / 废标 / 重大偏差条款")
    lines.append("-" * 60)

    if not rules:
        lines.append("未提取到否决投标、废标或重大偏差条款。")
        lines.append("")
        return

    for index, item in enumerate(rules, start=1):
        lines.append(f"{index}. {item.get('title', '未命名条款')}")
        lines.append(f"   编号：{item.get('id', '')}")

        if item.get("description"):
            lines.append(f"   条款说明：{item['description']}")

        if item.get("trigger_condition"):
            lines.append(f"   触发条件：{item['trigger_condition']}")

        if item.get("original_text"):
            lines.append(f"   原文依据：{item['original_text']}")

        lines.append("")


def append_manual_review_points(lines: list[str], points: list[dict[str, Any]]) -> None:
    lines.append("四、人工复核建议")
    lines.append("-" * 60)

    if not points:
        lines.append("无人工复核建议。")
        return

    for index, item in enumerate(points, start=1):
        lines.append(f"{index}. {item.get('content', '')}")
        if item.get("reason"):
            lines.append(f"   原因：{item['reason']}")
        lines.append("")


def append_summary(lines: list[str], summary: dict[str, Any]) -> None:
    lines.append("五、提取汇总")
    lines.append("-" * 60)

    if not summary:
        lines.append("无汇总信息。")
        return

    lines.append(f"资格评审标准数量：{summary.get('qualification_count', 0)}")
    lines.append(f"废标/否决投标条款数量：{summary.get('disqualification_count', 0)}")
    lines.append(f"评分因素数量：{summary.get('scoring_item_count', 0)}")
    lines.append(f"评分总分：{summary.get('scoring_total_score', 0)}")

    score_types = []
    if summary.get("has_technical_score"):
        score_types.append("技术")
    if summary.get("has_business_score"):
        score_types.append("商务")
    if summary.get("has_price_score"):
        score_types.append("价格")
    lines.append(f"评分类型：{'、'.join(score_types) if score_types else '未提取'}")
    lines.append("")


def save_extracted_requirements_text(input_json_path: Path, output_text_path: Path) -> None:
    save_text_from_json(input_json_path, output_text_path, generate_extracted_requirements_text)