from __future__ import annotations

import json
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from ai_bid_evaluator.config import Settings
from ai_bid_evaluator.search_opportunity.models import OpportunityCandidate
from ai_bid_evaluator.search_opportunity.searcher import DEFAULT_USER_AGENTS
from ai_bid_evaluator.utils.markdown_loader import load_file_as_markdown

# 判定页面是否为招标公告的关键词
TENDER_CONTENT_MARKERS = ["招标", "采购", "投标", "资格"]
# 优先抽取的主内容容器 class 片段
CONTENT_CONTAINER_MARKERS = ["vT_detail_content", "vF_detail_content", "article", "detail", "content"]
BLOCKED_PAGE_MARKERS = ["访问验证", "验证码", "请求被拦截", "访问过于频繁"]


class TenderCrawler:
    def __init__(self, settings: Settings, out_dir: Path) -> None:
        self.settings = settings
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = out_dir / "index.json"

    async def crawl(self, candidate: OpportunityCandidate) -> OpportunityCandidate:
        """抓取候选公告正文并转 markdown。失败时标记 fetch_status 并返回，不抛异常。"""
        headers = {
            "User-Agent": DEFAULT_USER_AGENTS[0],
            "Referer": candidate.url,
        }
        try:
            async with httpx.AsyncClient(
                timeout=self.settings.crawl_timeout_seconds, headers=headers, follow_redirects=True
            ) as client:
                resp = await client.get(candidate.url)
                resp.raise_for_status()
                html = _decode(resp)
        except Exception as exc:
            candidate.fetch_status = "failed"
            candidate.fetch_note = f"请求失败：{exc}"
            self._update_index(candidate)
            return candidate

        if any(m in html for m in BLOCKED_PAGE_MARKERS):
            candidate.fetch_status = "failed"
            candidate.fetch_note = "页面疑似被拦截（验证码/访问过于频繁）"
            self._update_index(candidate)
            return candidate

        main_html = self._extract_main_html(html)
        text_only = _strip_tags(main_html)
        if not any(m in text_only for m in TENDER_CONTENT_MARKERS):
            candidate.fetch_status = "failed"
            candidate.fetch_note = "页面内容置信度低，未识别到招标/采购关键词"
            self._update_index(candidate)
            return candidate

        # 原始 HTML 与清洗后 HTML 落盘
        html_path = self.out_dir / f"{candidate.candidate_id}.html"
        cleaned_path = self.out_dir / f"{candidate.candidate_id}_cleaned.html"
        html_path.write_text(html, encoding="utf-8")
        cleaned_path.write_text(main_html, encoding="utf-8")

        try:
            md_content = load_file_as_markdown(cleaned_path)
        except Exception as exc:
            candidate.fetch_status = "failed"
            candidate.fetch_note = f"MarkItDown 转换失败：{exc}"
            candidate.html_path = html_path
            self._update_index(candidate)
            return candidate

        md_path = self.out_dir / f"{candidate.candidate_id}.md"
        md_path.write_text(md_content, encoding="utf-8")

        candidate.fetch_status = "done"
        candidate.fetch_note = ""
        candidate.html_path = html_path
        candidate.md_path = md_path
        self._update_index(candidate)
        return candidate

    def _extract_main_html(self, html: str) -> str:
        """抽取主内容 HTML（去掉导航/页脚/脚本），优先按已知容器类名定位。"""
        soup = BeautifulSoup(html, "lxml")

        for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "iframe", "form"]):
            tag.decompose()

        container = None
        for marker in CONTENT_CONTAINER_MARKERS:
            container = soup.find(
                attrs={"class": lambda c: c and any(marker in (x or "").lower() for x in (c if isinstance(c, list) else [c]))}
            )
            if container is not None:
                break

        if container is None:
            container = soup.find("body") or soup

        # 移除正文中的空标签
        for tag in container.find_all(True):
            if tag.name in ("div", "p", "span", "td") and not tag.get_text(strip=True):
                tag.decompose()

        return str(container)

    def _update_index(self, candidate: OpportunityCandidate) -> None:
        """把候选状态写入 index.json（保留历史条目）。"""
        index: dict = {}
        if self.index_path.exists():
            try:
                index = json.loads(self.index_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                index = {}
        index[candidate.candidate_id] = candidate.to_dict()
        self.index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def _decode(resp: httpx.Response) -> str:
    charset = resp.encoding or ""
    content = resp.content
    try:
        if charset and charset.lower() not in ("utf-8", "utf8"):
            return content.decode(charset, errors="replace")
        return content.decode("utf-8", errors="replace")
    except Exception:
        try:
            return content.decode("gbk", errors="replace")
        except Exception:
            return content.decode("utf-8", errors="replace")


def _strip_tags(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    return soup.get_text("\n", strip=True)
