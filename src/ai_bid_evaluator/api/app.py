from contextlib import asynccontextmanager
import logging
import re
import time
from uuid import uuid4
import httpx
from fastapi import FastAPI, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from pydantic.json_schema import models_json_schema
from ai_bid_evaluator.config import Settings, load_settings
from ai_bid_evaluator.logging_setup import configure_logging, request_id_var
from ai_bid_evaluator.infrastructure.db import Database
from ai_bid_evaluator.infrastructure.repositories import RunRepository
from .errors import install_handlers, error_response
from .schemas import HealthResponse, ErrorResponse, PUBLIC_MODELS
from .routers import business_router
from .upload_limits import UploadBodyLimit


def create_app(settings: Settings | None = None, overrides: dict | None = None) -> FastAPI:
    settings = settings or load_settings()
    configure_logging("api")
    log = logging.getLogger("ai_bid_evaluator.api")

    @asynccontextmanager
    async def lifespan(app):
        settings.project_root.joinpath("data").mkdir(parents=True, exist_ok=True)
        log.info("api_starting", extra={"database": settings.database_url,
                                        "project_root": str(settings.project_root), "model": settings.doc_model})
        if not settings.api_key:
            log.warning("model_key_missing", extra={"hint": "DASHSCOPE_API_KEY 未配置，真实评审任务会直接失败"})
        app.state.db = Database(settings.database_url)
        app.state.http = httpx.AsyncClient(timeout=settings.crawl_timeout_seconds)
        app.state.gateway = None
        app.state.startup_ready = False
        try:
            try:
                app.state.db.migrate()
                app.state.startup_ready = True
                log.info("database_ready", extra={"database": settings.database_url})
            except Exception:
                # Live remains useful; readiness reports a safe 503.
                app.state.startup_ready = False
                log.exception("database_migration_failed", extra={"database": settings.database_url})
            app.state.repository = RunRepository(app.state.db)
            yield
        finally:
            log.info("api_stopping")
            await app.state.http.aclose()
            app.state.db.close()

    app = FastAPI(title="招投标辅助评审后端", version="0.2.0", lifespan=lifespan)
    app.state.settings = settings
    if overrides:
        app.dependency_overrides.update(overrides)
    app.add_middleware(UploadBodyLimit, limit=settings.upload_limit_bytes)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_credentials=False,
                       allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "Idempotency-Key", "X-Request-ID"])

    @app.middleware("http")
    async def request_id(request, call_next):
        supplied = request.headers.get("X-Request-ID", "")
        request.state.request_id = supplied if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", supplied) else uuid4().hex
        token = request_id_var.set(request.state.request_id)
        started = time.perf_counter()
        base = {"method": request.method, "path": request.url.path, "request_id": request.state.request_id}
        try:
            response = await call_next(request)
        except Exception:
            log.error("http_request", extra={**base, "status": 500,
                                             "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
            raise
        else:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            record = log.warning if response.status_code >= 500 else log.info
            record("http_request", extra={**base, "status": response.status_code, "duration_ms": duration_ms})
            response.headers["X-Request-ID"] = request.state.request_id
            return response
        finally:
            request_id_var.reset(token)

    install_handlers(app)
    router = APIRouter(prefix="/api/v1/health", tags=["health"])

    @router.get("/live", response_model=HealthResponse, operation_id="health_live")
    def live():
        return HealthResponse(status="live", model_configured=bool(settings.api_key))

    @router.get("/ready", response_model=HealthResponse, responses={503: {"model": ErrorResponse}}, operation_id="health_ready")
    def ready(request: Request):
        try:
            configured = settings.lease_seconds > settings.heartbeat_seconds > 0 and settings.chunk_max_tokens >= 4
            if not configured or not request.app.state.startup_ready or not request.app.state.db.ready():
                raise RuntimeError("not ready")
            return HealthResponse(status="ready", model_configured=bool(settings.api_key))
        except Exception:
            return error_response(request, 503, "not_ready", "数据库或必要配置未就绪")

    app.include_router(router)
    app.include_router(business_router())

    def openapi():
        if app.openapi_schema is None:
            result = get_openapi(title=app.title, version=app.version, routes=app.routes)
            _, definitions = models_json_schema([(m, "serialization") for m in PUBLIC_MODELS], ref_template="#/components/schemas/{model}")
            result.setdefault("components", {}).setdefault("schemas", {}).update(definitions.get("$defs", {}))
            for path in result["paths"].values():
                for method, operation in path.items():
                    if method in {"get", "post"}:
                        operation["responses"]["422"] = {"description": "字段校验失败", "content": {"application/json": {
                            "schema": {"$ref": "#/components/schemas/ErrorResponse"}}}}
            app.openapi_schema = result
        return app.openapi_schema

    app.openapi = openapi
    return app


def export_openapi(path):
    import json
    from pathlib import Path
    Path(path).write_text(json.dumps(create_app().openapi(), ensure_ascii=False, indent=2), encoding="utf-8")
