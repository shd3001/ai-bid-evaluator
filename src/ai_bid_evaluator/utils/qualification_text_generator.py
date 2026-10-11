from pathlib import Path
from typing import Any

from ai_bid_evaluator.utils.json_utils import save_text_from_json


def generate_qualification_text(data: dict[str, Any]) -> str:
    results = data.get("qualification_results", [])

    lines = []

    lines.append("资质审查结果说明")
    lines.append("=" * 60)
    lines.append("")

    if not results:
        lines.append("未找到资质审查结果。")
        return "\n".join(lines)

    for index, result in enumerate(results, start=1):
        append_result(lines, index, result)

    return "\n".join(lines)


def append_result(lines: list[str], index: int, result: dict[str, Any]) -> None:
    document_info = result.get("document_info", {})
    bidder = document_info.get("bidder") or result.get("bidder_name") or f"投标人{index}"
    status = result.get("status")
    if status not in ("passed", "failed", "needs_review"):
        value = result.get("all_passed")
        status = "passed" if value is True else "failed" if value is False else "needs_review"

    lines.append(f"{index}. 投标人：{bidder}")
    lines.append("-" * 60)
    lines.append(f"   资质审查结论：{ {'passed': '通过', 'failed': '不通过', 'needs_review': '需人工复核'}[status] }")

    if result.get("summary"):
        lines.append(f"   总体说明：{result.get('summary')}")

    lines.append("")
    lines.append("   逐项审查结果：")

    checks = result.get("qualification_check", [])
    if not checks:
        lines.append("   未找到逐项资质审查结果。")
    else:
        for item_index, item in enumerate(checks, start=1):
            append_check_item(lines, item_index, item)

    failed = result.get("failed_requirements", [])
    lines.append("")
    lines.append("   未通过资质项：")

    if not failed:
        lines.append("   无。")
    else:
        for failed_index, item in enumerate(failed, start=1):
            lines.append(f"   {failed_index}. {item.get('title', '未命名资质项')}")
            lines.append(f"      编号：{item.get('id', '')}")
            lines.append(f"      原因：{item.get('reason', '')}")

    lines.append("")
    lines.append("=" * 60)
    lines.append("")


def append_check_item(lines: list[str], index: int, item: dict[str, Any]) -> None:
    lines.append(f"   {index}. {item.get('title', '未命名资质项')}")
    lines.append(f"      编号：{item.get('id', '')}")
    lines.append(f"      是否强制：{'是' if item.get('is_mandatory', True) else '否'}")
    value = item.get('passed')
    label = '通过' if value is True else '不通过' if value is False else '需人工复核'
    lines.append(f"      审查结果：{label}")

    if item.get("note"):
        lines.append(f"      审查说明：{item.get('note')}")

    if item.get("matched_content"):
        lines.append(f"      匹配内容：{item.get('matched_content')}")

    lines.append("")


def save_qualification_text(input_json_path: Path, output_text_path: Path) -> None:
    save_text_from_json(input_json_path, output_text_path, generate_qualification_text)
