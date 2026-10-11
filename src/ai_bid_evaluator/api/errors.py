from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from ai_bid_evaluator.domain.exceptions import DomainError


def error_response(request, status, code, message, details=None):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message,
                        "details": details or {}, "request_id": getattr(request.state, "request_id", "unknown")}})


def install_handlers(app):
    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        return error_response(request, exc.http_status, exc.code, str(exc), exc.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        fields = [{"path": list(e["loc"]), "type": e["type"]} for e in exc.errors()]
        return error_response(request, 422, "validation_error", "字段校验失败", {"fields": fields})

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return error_response(request, exc.status_code, "not_found" if exc.status_code == 404 else "http_error", "资源不存在" if exc.status_code == 404 else "请求无法处理")

    @app.exception_handler(Exception)
    async def internal_error(request, exc):
        return error_response(request, 500, "internal_error", "服务内部错误")
