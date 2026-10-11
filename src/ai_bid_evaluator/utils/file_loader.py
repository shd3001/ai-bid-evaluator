import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from ai_bid_evaluator.models import BidEvaluationInput, BidFileInput


def resolve_path(project_root: Path, value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = project_root / path
    return path


def load_bid_eval_input(input_path: Path, project_root: Path) -> BidEvaluationInput:
    raw = json.loads(input_path.read_text(encoding="utf-8"))

    return BidEvaluationInput(
        project_name=raw["project_name"],
        announcement_file=resolve_path(project_root, raw["announcement_file"]),
        tender_file=resolve_path(project_root, raw["tender_file"]),
        bid_files=[
            BidFileInput(
                bidder_name=item["bidder_name"],
                file=resolve_path(project_root, item["file"]),
                bidder_id=item.get("bidder_id") or f"b_{uuid4().hex}",
            )
            for item in raw["bid_files"]
        ],
    )


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_json(path: Path) -> dict:
    while True:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, FileNotFoundError) as e:
            print(f"文件读取失败：{path}，错误：{e}")
            input("请修正文件后按回车重试...")
