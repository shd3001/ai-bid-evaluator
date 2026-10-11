from fastapi import Request
from ai_bid_evaluator.application.run_service import RunService
from ai_bid_evaluator.application.review_service import ReviewService
from ai_bid_evaluator.application.report_service import ReportService
from ai_bid_evaluator.application.query_service import QueryService
from ai_bid_evaluator.application.document_service import DocumentService


def get_repository(request: Request):
    if not request.app.state.startup_ready:
        from ai_bid_evaluator.domain.exceptions import ModelFailure
        raise ModelFailure("数据库未就绪")
    return request.app.state.repository


def get_query_service(request: Request):
    return QueryService(get_repository(request))


def get_document_service(request: Request):
    settings = request.app.state.settings
    return DocumentService(get_repository(request), settings.project_root, settings.upload_limit_bytes)


def get_run_service(request: Request):
    return RunService(get_repository(request))


def get_review_service(request: Request):
    return ReviewService(get_repository(request))


def get_report_service(request: Request):
    return ReportService(get_repository(request))


def get_gateway(request: Request):
    return request.app.state.gateway
