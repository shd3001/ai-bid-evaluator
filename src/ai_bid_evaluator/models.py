from dataclasses import dataclass
from pathlib import Path
from dataclasses import field
from uuid import uuid4


@dataclass
class BidFileInput:
    bidder_name: str
    file: Path
    file_id: str | None = None
    markdown_content: str | None = None
    bidder_id: str = field(default_factory=lambda: f"b_{uuid4().hex}")


@dataclass
class BidEvaluationInput:
    project_name: str
    announcement_file: Path
    tender_file: Path
    bid_files: list[BidFileInput]
    announcement_file_id: str | None = None
    tender_file_id: str | None = None
    announcement_markdown: str | None = None
    tender_markdown: str | None = None
