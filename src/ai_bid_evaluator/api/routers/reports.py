import html
import json
from typing import Literal
from fastapi import APIRouter, Depends, Response
from ai_bid_evaluator.api.schemas import ReportResponse, Page
from ai_bid_evaluator.api.dependencies import get_query_service
from ai_bid_evaluator.domain.base import Identifier
from ai_bid_evaluator.domain.exceptions import Conflict
from .common import Limit, Cursor

router = APIRouter(tags=["reports"])


@router.get("/runs/{run_id}/reports", response_model=Page[ReportResponse], operation_id="reports_list")
def reports(run_id: Identifier, limit: Limit = 20, cursor: Cursor = None, service=Depends(get_query_service)):
    return service.reports(run_id, limit, cursor)


@router.get("/reports/{report_id}", response_model=ReportResponse, operation_id="reports_get")
def report(report_id: int, service=Depends(get_query_service)):
    return service.report(report_id)


@router.get("/reports/{report_id}/export", response_class=Response, operation_id="reports_export",
            responses={200: {"description": "报告下载", "content": {"application/json": {}, "text/markdown": {}, "text/html": {}}}})
def export(report_id: int, format: Literal["json", "markdown", "html"] = "json", service=Depends(get_query_service)):
    report = service.report(report_id)
    if report["stale"] or not report["confirmed"]:
        raise Conflict("报告尚未确认或已经过期")
    text = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
    extension, media = {"json": ("json", "application/json"), "markdown": ("md", "text/markdown"), "html": ("html", "text/html")}[format]
    if format == "markdown":
        text = f"# 辅助评审报告 {report_id}\n\n" + "\n".join("    " + line for line in text.splitlines()) + "\n"
    elif format == "html":
        text = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>辅助评审报告</title><body><h1>辅助评审报告</h1><pre>' + html.escape(text) + '</pre></body></html>'
    return Response(text, media_type=media, headers={"Content-Disposition": f'attachment; filename="report_{report_id}.{extension}"',
                    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})
