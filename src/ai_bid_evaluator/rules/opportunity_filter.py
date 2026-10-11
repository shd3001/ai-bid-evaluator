"""Conservative metadata extraction and deterministic eligibility filters."""
import re
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from ai_bid_evaluator.domain.opportunity import TenderNotice, OpportunityAssessment


def canonicalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("公告 URL 必须是 HTTP(S) 地址")
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    if parts.port and (scheme, parts.port) not in {("http", 80), ("https", 443)}:
        host += f":{parts.port}"
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid"}]
    return urlunsplit((scheme, host, parts.path or "/", urlencode(query), ""))


def notice_type(title):
    if any(t in title for t in ("终止", "废标", "流标", "撤销")):
        return "termination"
    if any(t in title for t in ("中标", "成交", "结果公告")):
        return "award"
    if any(t in title for t in ("更正", "变更", "补充", "澄清")):
        return "correction"
    if any(t in title for t in ("招标公告", "采购公告", "磋商公告", "询价公告", "谈判公告", "资格预审公告")):
        return "tender"
    return "unknown"


def parse_notice(notice_id, title, url, document, providers):
    text = document.text
    diagnostics = []
    def extract(label, converter=str):
        # Match whole labels. A generic suffix must never turn a registration,
        # clarification or payment deadline into a submission deadline.
        raw = re.findall(r"(?:^|[\n|])\s*(?:" + label + r")[：:]\s*([^\n|]+)", text)
        values = set()
        try:
            values = {converter(s.strip()) for s in raw}
            if len(values) == 1:
                return values.pop()
        except (ValueError, ArithmeticError):
            pass
        if raw:
            diagnostics.append(f"{label}: 无法解析或存在多个不同值")
        return None
    def money(value):
        match = re.fullmatch(r"(?:人民币\s*)?([\d,]+(?:\.\d+)?)\s*(亿元|万元|元)(?:人民币)?[。；;]?", value)
        if not match:
            raise ValueError()
        return Decimal(match[1].replace(",", "")) * {"元": Decimal(1), "万元": Decimal(10000), "亿元": Decimal(100000000)}[match[2]]
    def deadline(value):
        match = re.fullmatch(r"(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})日?\s*(\d{1,2})[:：](\d{2})(?::(\d{2}))?(?:\s*北京时间)?[。；;]?", value)
        if not match:
            raise ValueError()
        return datetime(*[int(v or 0) for v in match.groups()], tzinfo=timezone(timedelta(hours=8)))
    header = next((line.strip() for line in text.splitlines() if line.strip()), "")
    kind = notice_type(title)
    body_kind = notice_type(header)
    if body_kind != "unknown" and kind != body_kind:
        kind = "unknown"
        diagnostics.append("标题与正文公告类型不一致")
    refs = [c.evidence() for c in document.chunks if any(x in c.text for x in ("截止", "预算", "项目地区", "项目编号", "标段", "公告类型"))]
    return TenderNotice(notice_id=notice_id, title=title, url=canonicalize_url(url), notice_type=kind,
        deadline=extract("投标截止时间|响应截止时间|提交投标文件截止时间|截止时间", deadline),
        budget=extract("预算金额|项目预算|采购预算", money), region=extract("项目地区|项目地域|项目所在地"),
        project_number=extract("项目编号|采购编号"), lot_id=extract("标段编号|标段号|包号"),
        providers=sorted(set(providers)), evidence=refs, diagnostics=diagnostics)


def filter_notice(notice: TenderNotice, request, now: datetime) -> OpportunityAssessment:
    if now.tzinfo is None:
        raise ValueError("筛选时钟必须包含时区")
    excluded, unknown = [], []
    if notice.notice_type in {"award", "termination"}:
        excluded.append("中标/成交或终止公告不能作为当前投标机会")
    elif notice.notice_type != "tender":
        unknown.append("更正公告或未知类型需要核对关联的有效招标公告")
    if notice.deadline is None:
        unknown.append("投标截止时间未知或存在冲突")
    elif notice.deadline <= now:
        excluded.append("投标已截止（截止时间等于当前时间也不可投标）")
    if request.min_budget is not None or request.max_budget is not None:
        if notice.budget is None:
            unknown.append("预算金额未知或存在冲突")
        elif (request.min_budget is not None and notice.budget < request.min_budget) or (request.max_budget is not None and notice.budget > request.max_budget):
            excluded.append("公告预算不满足本次预算范围")
    if request.regions:
        if not notice.region:
            unknown.append("项目地域未知或存在冲突")
        elif not any(region in notice.region for region in request.regions):
            excluded.append("项目地域不满足本次筛选范围")
    status = "unsuitable" if excluded else "needs_review" if unknown else "suitable"
    return OpportunityAssessment(candidate_id=notice.notice_id, status=status, reasons=excluded + unknown, evidence=notice.evidence)


def apply_notice_filter(result, notice, request, now):
    filtered = filter_notice(notice, request, now)
    if filtered.status == "suitable":
        return result
    return result.model_copy(update={"status": filtered.status, "reasons": result.reasons + filtered.reasons,
                                     "evidence": result.evidence + [e for e in filtered.evidence if e not in result.evidence]})
