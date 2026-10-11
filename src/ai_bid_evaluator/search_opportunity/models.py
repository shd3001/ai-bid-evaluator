from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class SearchResult:
    """单个搜索结果（搜索 API / 政府站爬虫归一化后的条目）。"""
    title: str
    url: str
    snippet: str = ""
    published_date: str = ""
    source_name: str = ""
    provider: str = ""
    project_number: str | None = None
    lot_id: str | None = None


@dataclass
class OpportunityCandidate:
    """一个待评估的招标机会候选。"""
    candidate_id: str                # c01, c02, ...
    title: str
    url: str
    snippet: str = ""
    published_date: str = ""
    source_name: str = ""
    provider: str = ""               # bocha / ccgp
    fetch_status: str = "pending"    # pending / done / failed / skipped
    fetch_note: str = ""
    md_path: Path | None = None
    html_path: Path | None = None
    extract: dict | None = None
    suitability: dict | None = None
    providers: list[str] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)
    project_number: str | None = None
    lot_id: str | None = None

    def to_dict(self) -> dict:
        return {
            "candidate_id": self.candidate_id,
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
            "published_date": self.published_date,
            "source_name": self.source_name,
            "provider": self.provider,
            "providers": self.providers,
            "sources": self.sources,
            "project_number": self.project_number,
            "lot_id": self.lot_id,
            "fetch_status": self.fetch_status,
            "fetch_note": self.fetch_note,
            "suitability": self.suitability,
            "extract": self.extract,
            "md_path": str(self.md_path) if self.md_path else None,
            "html_path": str(self.html_path) if self.html_path else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "OpportunityCandidate":
        return cls(
            candidate_id=data.get("candidate_id", ""),
            title=data.get("title", ""),
            url=data.get("url", ""),
            snippet=data.get("snippet", ""),
            published_date=data.get("published_date", ""),
            source_name=data.get("source_name", ""),
            provider=data.get("provider", ""),
            providers=data.get("providers", []),
            sources=data.get("sources", []),
            project_number=data.get("project_number"),
            lot_id=data.get("lot_id"),
            fetch_status=data.get("fetch_status", "pending"),
            fetch_note=data.get("fetch_note", ""),
            suitability=data.get("suitability"),
            extract=data.get("extract"),
            md_path=Path(data["md_path"]) if data.get("md_path") else None,
            html_path=Path(data["html_path"]) if data.get("html_path") else None,
        )
