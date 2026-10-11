from __future__ import annotations

import asyncio
import datetime
import re
from dataclasses import replace
from typing import Protocol

import httpx
from bs4 import BeautifulSoup

from ai_bid_evaluator.config import Settings
from ai_bid_evaluator.search_opportunity.models import OpportunityCandidate, SearchResult
from ai_bid_evaluator.rules.opportunity_filter import canonicalize_url, notice_type


class SearchProvider(Protocol):
    name: str

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        ...


DEFAULT_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
]

TENDER_TITLE_MARKERS = ["招标", "磋商", "询价", "竞争性", "谈判", "采购", "资格预审", "招标公告", "公告"]
GOV_SOURCE_MARKERS = ["政府采购", "公共资源交易", "招标投标"]
GOV_URL_MARKERS = [".gov.cn", "ggzy", "ccgp"]


class BochaSearchProvider:
    """主搜索源：博查 AI 搜索（bochaai.com），响应结构兼容 Bing。"""

    name = "bocha"

    def __init__(self, api_key: str, base_url: str = "https://api.bochaai.com") -> None:
        self.api_key = api_key
        self.base_url = base_url

    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        if not self.api_key:
            raise RuntimeError("搜索来源未配置")

        today = datetime.date.today()
        start = today - datetime.timedelta(days=365)

        url = f"{self.base_url}/v1/web-search"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "query": query,
            "summary": True,
            "count": max(limit, 10),
            "freshness": f"{start.isoformat()}..{today.isoformat()}",
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except Exception:
            raise RuntimeError("博查搜索请求失败") from None

        results: list[SearchResult] = []
        for item in data.get("data", {}).get("webPages", {}).get("value", []) or []:
            title = (item.get("name") or "").strip()
            page_url = (item.get("url") or "").strip()
            if not title or not page_url:
                continue
            snippet = item.get("summary") or item.get("snippet") or ""
            results.append(
                SearchResult(
                    title=title,
                    url=page_url,
                    snippet=snippet,
                    published_date=_normalize_date(item.get("datePublished") or ""),
                    source_name=(item.get("siteName") or "").strip(),
                )
            )
        return results


class CcgpSearchProvider:
    """次搜索源：中国政府采购网搜索页（best-effort，解析失败时返回空）。"""

    name = "ccgp"

    def __init__(self) -> None:
        self.base_url = "https://search.ccgp.gov.cn"

    async def search(self, query: str, limit: int = 10) -> list[SearchResult]:
        headers = {
            "User-Agent": DEFAULT_USER_AGENTS[0],
            "Referer": f"{self.base_url}/",
        }
        today = datetime.date.today()
        params = {
            "searchtype": "1",
            "page_index": "1",
            "searchchannel": "0",
            "dbselect": "bidx",
            "kw": query,
            "bidSort": "0",
            "pinMu": "0",
            "bidType": "0",
            "start_time": (today - datetime.timedelta(days=365)).strftime("%Y:%m:%d"),
            "end_time": today.strftime("%Y:%m:%d"),
        }

        try:
            async with httpx.AsyncClient(
                timeout=30.0, headers=headers, follow_redirects=True
            ) as client:
                # 先访问首页拿 cookie，再搜索
                await client.get(f"{self.base_url}/")
                await asyncio.sleep(1.0)
                resp = await client.get(f"{self.base_url}/bxsearch", params=params)
                resp.raise_for_status()
                html = _decode_html(resp)
        except Exception:
            raise RuntimeError("政府采购网搜索请求失败") from None

        results: list[SearchResult] = []
        try:
            soup = BeautifulSoup(html, "lxml")
            # 结果列表 ul（class 通常含 vT-srch-result-list-bid），多类名回退
            list_node = None
            for ul in soup.find_all("ul"):
                cls = " ".join(ul.get("class") or [])
                if "result-list" in cls.lower() or "result" in cls.lower():
                    list_node = ul
                    break
            if list_node is None:
                if any(marker in html for marker in ("没有找到", "未找到", "暂无", "0条")):
                    return []
                raise RuntimeError("搜索来源返回页面无法解析")

            for li in list_node.find_all("li", recursive=False):
                a = li.find("a", href=True)
                if a is None:
                    a = li.find("a")
                if a is None or not a.get("href"):
                    continue
                title = a.get_text(strip=True)
                href = a["href"].strip()
                if not title or not href:
                    continue
                if href.startswith("/"):
                    href = "https://www.ccgp.gov.cn" + href
                date_span = li.find("span", class_=re.compile("time|date"))
                date_text = _normalize_date(date_span.get_text(strip=True) if date_span else "")
                results.append(
                    SearchResult(title=title, url=href, published_date=date_text, source_name="中国政府采购网")
                )
                if len(results) >= limit:
                    break
        except Exception:
            raise RuntimeError("政府采购网搜索解析失败") from None

        return results


class SearchService:
    """聚合多个 provider，去重、排序、截断成候选列表。"""

    def __init__(self, settings: Settings, providers: list[SearchProvider] | None = None) -> None:
        self.settings = settings
        self.max_candidates = max(1, settings.max_candidates)
        self.providers = providers
        self.diagnostics = []

    def _build_providers(self) -> list[SearchProvider]:
        providers: list[SearchProvider] = []
        for name in (self.settings.search_providers or "").split(","):
            name = name.strip().lower()
            if not name:
                continue
            if name == "bocha":
                providers.append(BochaSearchProvider(self.settings.search_api_key, self.settings.search_api_base))
            elif name == "ccgp":
                providers.append(CcgpSearchProvider())
        return providers

    async def search(self, queries: list[str], *, max_candidates: int | None = None) -> list[OpportunityCandidate]:
        limit = self.max_candidates if max_candidates is None else max_candidates
        if not 1 <= limit <= 100:
            raise ValueError("max_candidates 必须在 1–100 之间")
        providers = self.providers if self.providers is not None else self._build_providers()
        if not providers:
            raise RuntimeError("没有可用的搜索源，请检查 SEARCH_PROVIDERS 配置（如 bocha,ccgp）")

        collected: list[SearchResult] = []
        self.diagnostics = []
        for query in queries:
            print(f"搜索：{query}")
            for provider in providers:
                try:
                    results = await provider.search(query, limit=10)
                    self.diagnostics.append({"provider": provider.name, "query": query, "status": "succeeded" if results else "empty", "count": len(results)})
                    for r in results:
                        collected.append(replace(r, provider=provider.name))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.diagnostics.append({"provider": provider.name, "query": query, "status": "failed", "count": 0, "message": "搜索来源失败或未配置"})

        candidates = self._dedupe_and_rank(collected, max_candidates=limit)
        return candidates

    def _dedupe_and_rank(self, results: list[SearchResult], *, max_candidates: int | None = None) -> list[OpportunityCandidate]:
        groups = {}
        unique: list[SearchResult] = []
        for r in results:
            try:
                norm_url = canonicalize_url(r.url)
            except ValueError:
                continue
            key = ("project", r.project_number, r.lot_id, notice_type(r.title)) if r.project_number and r.lot_id else ("url", norm_url)
            if key not in groups:
                unique.append(r)
                groups[key] = []
            groups[key].append({"provider": r.provider, "url": norm_url, "source_name": r.source_name,
                                "published_date": r.published_date})

        def _score(r: SearchResult) -> tuple:
            url_lower = r.url.lower()
            gov_url = any(m in url_lower for m in GOV_URL_MARKERS)
            gov_source = any(m in (r.source_name or "") for m in GOV_SOURCE_MARKERS)
            title_has_tender = any(m in r.title for m in TENDER_TITLE_MARKERS)
            date_key = _date_sort_key(r.published_date)
            return (gov_url or gov_source, title_has_tender, date_key, r.title)

        # 排序：政府源优先 > 标题含招标关键词 > 日期新 > 标题
        unique.sort(key=_score, reverse=True)

        candidates: list[OpportunityCandidate] = []
        for idx, r in enumerate(unique[: max_candidates if max_candidates is not None else self.max_candidates], start=1):
            candidates.append(
                OpportunityCandidate(
                    candidate_id=f"c{idx:02d}",
                    title=r.title,
                    url=r.url,
                    snippet=r.snippet,
                    published_date=r.published_date,
                    source_name=r.source_name,
                    provider=r.provider,
                    providers=sorted({s["provider"] for s in groups[("project", r.project_number, r.lot_id, notice_type(r.title)) if r.project_number and r.lot_id else ("url", canonicalize_url(r.url))] if s["provider"]}),
                    sources=groups[("project", r.project_number, r.lot_id, notice_type(r.title)) if r.project_number and r.lot_id else ("url", canonicalize_url(r.url))],
                    project_number=r.project_number, lot_id=r.lot_id,
                )
            )
        return candidates


def _decode_html(resp: httpx.Response) -> str:
    """按 Content-Type charset 解码，utf-8 失败回退 gbk。"""
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


def _normalize_date(text: str) -> str:
    """把各种日期格式归一化为 YYYY-MM-DD；无法识别返回空串。"""
    text = (text or "").strip()
    if not text:
        return ""
    m = re.search(r"(\d{4})[-/:年.](\d{1,2})[-/:月.](\d{1,2})", text)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"(\d{4})[-/:年.](\d{1,2})", text)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    return ""


def _date_sort_key(date_text: str) -> str:
    """日期排序键：缺失日期视为最旧。"""
    return date_text or "0000-00-00"
