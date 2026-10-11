from __future__ import annotations

from typing import Any


# 常见工程项目类型，用于拼装搜索查询
PROJECT_TYPE_POOL = [
    "施工",
    "工程",
    "采购",
    "货物",
    "设备采购",
    "服务",
    "信息化",
    "运维",
]


def _clean_text(value: Any) -> str:
    text = str(value or "").strip()
    return " ".join(text.split())


def _industry_words(profile: dict) -> list[str]:
    """从能力画像提取行业词：industry + business_scope 前若干项。"""
    words: list[str] = []

    industry = _clean_text(profile.get("industry"))
    if industry and industry not in words:
        words.append(industry)

    for scope in profile.get("business_scope", []) or []:
        scope = _clean_text(scope)
        if scope and scope not in words:
            words.append(scope)

    # 资质名也可以作为行业词（如"公路机电工程"专项承包壹级 -> 提取主干词）
    for q in profile.get("qualifications", []) or []:
        name = _clean_text(q.get("name") if isinstance(q, dict) else q)
        if name and name not in words:
            words.append(name)

    return words


def generate_search_keywords(
    profile: dict,
    regions: list[str] | None = None,
    budget: dict | None = None,
    overrides: list[str] | None = None,
    max_keywords: int = 4,
) -> list[str]:
    """生成招标公告搜索查询词。

    - overrides 非空时直接返回 overrides（用户手动指定优先）。
    - 否则从能力画像提取行业词，与项目类型、地域、预算组合出查询词。
    """
    if overrides:
        return [kw.strip() for kw in overrides if kw.strip()]

    regions = [r.strip() for r in (regions or []) if r.strip()]

    industry_words = _industry_words(profile)
    if not industry_words:
        industry_words = ["工程"]

    queries: list[str] = []

    # 模板1（优先）：地域 + 行业词 + 招标（地域是用户最看重的过滤条件）
    for region in regions[:2]:
        for word in industry_words[:2]:
            queries.append(f"{region} {word} 招标")

    # 模板2：行业词 + 项目类型 + "招标公告"
    for word in industry_words[:2]:
        for ptype in PROJECT_TYPE_POOL[:3]:
            queries.append(f"{word} {ptype} 招标公告")

    # 模板3：行业词 + 采购 公告
    for word in industry_words[:2]:
        queries.append(f"{word} 采购 公告")

    # 预算过滤词（软过滤，附加到查询中）
    if budget and budget.get("max"):
        try:
            max_yuan = float(budget["max"])
            if max_yuan >= 10000:
                queries.append(f"预算 {int(max_yuan / 10000)} 万元以内 招标")
        except (TypeError, ValueError):
            pass

    # 去重（保持顺序）
    seen: set[str] = set()
    result: list[str] = []
    for q in queries:
        if q not in seen:
            seen.add(q)
            result.append(q)
        if len(result) >= max_keywords:
            break

    return result
