from pathlib import Path
from typing import Any

from ai_bid_evaluator.utils.json_utils import save_text_from_json


def generate_scoring_text(data: dict[str, Any]) -> str:
    scoring_results = data.get("scoring_results", data)

    if isinstance(scoring_results, dict):
        scoring_results = [scoring_results]

    lines = []
    lines.append("评分结果说明")
    lines.append("=" * 60)
    lines.append("")

    for index, result in enumerate(scoring_results, start=1):
        append_bidder_result(lines, index, result)

    return "\n".join(lines)


def append_bidder_result(lines: list[str], index: int, result: dict[str, Any]) -> None:
    bidder_name = result.get("bidder_name", f"投标人{index}")
    total_score = result.get("total_score", 0)
    max_total_score = result.get("max_total_score", 0)

    lines.append(f"{index}. 投标人：{bidder_name}")
    lines.append(f"   总得分：{total_score} / {max_total_score}")
    lines.append("")

    qualification = result.get("qualification_reference", {})
    if qualification:
        lines.append("   资格审查参考：")
        lines.append(f"   - 状态：{qualification.get('qualification_status', '')}")
        lines.append(f"   - 说明：{qualification.get('note', '')}")
        lines.append("")

    lines.append("   逐项评分：")
    items = result.get("items", [])

    if not items:
        lines.append("   未生成评分项。")
    else:
        for item_index, item in enumerate(items, start=1):
            append_score_item(lines, item, f"{index}.{item_index}", indent="   ")

    append_list(lines, "优点", result.get("strengths", []), indent="   ")
    append_list(lines, "不足", result.get("weaknesses", []), indent="   ")

    review_points = result.get("manual_review_points", [])
    if review_points:
        lines.append("   人工复核点：")
        for point in review_points:
            item_id = point.get("item_id", "")
            reason = point.get("reason", "")
            lines.append(f"   - {item_id}：{reason}")
        lines.append("")

    summary = result.get("summary", "")
    if summary:
        lines.append("   评分总结：")
        lines.append(f"   {summary}")
        lines.append("")

    score_check = result.get("score_check", {})
    if score_check:
        lines.append("   评分校验：")
        lines.append(f"   - 总分校验：{'通过' if score_check.get('score_sum_valid') else '不通过'}")
        lines.append(f"   - 校验总分：{score_check.get('calculated_total_score', '')}")
        lines.append(f"   - 满分校验：{'通过' if score_check.get('max_score_sum_valid') else '不通过'}")
        lines.append(f"   - 校验满分：{score_check.get('calculated_max_total_score', '')}")
        notes = score_check.get("notes", [])
        if notes:
            for note in notes:
                lines.append(f"   - 备注：{note}")
        lines.append("")

    lines.append("-" * 60)
    lines.append("")


def append_score_item(
    lines: list[str],
    item: dict[str, Any],
    number: str,
    indent: str = "",
) -> None:
    title = item.get("title", "未命名评分项")
    score = item.get("score", 0)
    max_score = item.get("max_score", 0)
    deduction_reason = item.get("deduction_reason", "")
    matched_content = item.get("matched_content", "")
    scoring_rule = item.get("scoring_rule", "")

    lines.append(f"{indent}{number} {title}")
    lines.append(f"{indent}   得分：{score} / {max_score}")

    if item.get("category"):
        lines.append(f"{indent}   类别：{item['category']}")

    if scoring_rule:
        lines.append(f"{indent}   评分规则：{scoring_rule}")

    if matched_content:
        lines.append(f"{indent}   匹配内容：{matched_content}")

    if deduction_reason:
        lines.append(f"{indent}   扣分原因：{deduction_reason}")

    scoring_reason = item.get("scoring_reason", "")
    if scoring_reason:
        lines.append(f"{indent}   评分理由：{scoring_reason}")

    children = item.get("children", [])
    details = item.get("details", [])

    for child_index, child in enumerate(children, start=1):
        append_score_item(lines, child, f"{number}.{child_index}", indent=f"{indent}   ")

    for detail_index, detail in enumerate(details, start=1):
        append_score_item(lines, detail, f"{number}.{detail_index}", indent=f"{indent}   ")

    lines.append("")


def append_list(lines: list[str], title: str, values: list[Any], indent: str = "") -> None:
    if not values:
        return

    lines.append(f"{indent}{title}：")
    for value in values:
        lines.append(f"{indent}- {value}")
    lines.append("")


def save_scoring_text(input_json_path: Path, output_text_path: Path) -> None:
    save_text_from_json(input_json_path, output_text_path, generate_scoring_text)