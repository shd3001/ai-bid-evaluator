import logging
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from ai_bid_evaluator.domain.exceptions import DomainError

logger = logging.getLogger("ai_bid_evaluator.api")


def _context(request) -> dict:
    """只取排障必需的字段，绝不落请求头或请求体。"""
    context = {
        "request_id": getattr(request.state, "request_id", None),
        "method": getattr(request, "method", None),
        "path": getattr(getattr(request, "url", None), "path", None),
    }
    return {key: value for key, value in context.items() if value is not None}


def error_response(request, status, code, message, details=None):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message,
                        "details": details or {}, "request_id": getattr(request.state, "request_id", "unknown")}})


def install_handlers(app):
    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        logger.warning("domain_error", extra={**_context(request), "code": exc.code, "status": exc.http_status})
        return error_response(request, exc.http_status, exc.code, str(exc), exc.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        fields = [{"path": list(e["loc"]), "type": e["type"]} for e in exc.errors()]
        logger.warning("validation_error", extra={**_context(request), "status": 422,
                                                  "fields": [field["path"] for field in fields]})
        return error_response(request, 422, "validation_error", "字段校验失败", {"fields": fields})

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        if exc.status_code >= 500:
            logger.error("http_error", extra={**_context(request), "status": exc.status_code})
        else:
            logger.debug("http_error", extra={**_context(request), "status": exc.status_code})
        return error_response(request, exc.status_code, "not_found" if exc.status_code == 404 else "http_error", "资源不存在" if exc.status_code == 404 else "请求无法处理")

    @app.exception_handler(Exception)
    async def internal_error(request, exc):
        # 500 必须留堆栈，否则线上只能看到"服务内部错误"。
        logger.exception("unhandled_error", extra=_context(request))
        return error_response(request, 500, "internal_error", "服务内部错误")