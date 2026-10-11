from contextlib import asynccontextmanager
import re
from uuid import uuid4
import httpx
from fastapi import FastAPI, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from pydantic.json_schema import models_json_schema
from ai_bid_evaluator.config import Settings, load_settings
from ai_bid_evaluator.infrastructure.db import Database
from ai_bid_evaluator.infrastructure.repositories import RunRepository
from .errors import install_handlers, error_response
from .schemas import HealthResponse, ErrorResponse, PUBLIC_MODELS
from .routers import business_router
from .upload_limits import UploadBodyLimit


def create_app(settings: Settings | None = None, overrides: dict | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app):
        settings.project_root.joinpath("data").mkdir(parents=True, exist_ok=True)
        app.state.db = Database(settings.database_url)
        app.state.http = httpx.AsyncClient(timeout=settings.crawl_timeout_seconds)
        app.state.gateway = None
        app.state.startup_ready = False
        try:
            try:
                app.state.db.migrate()
                app.state.startup_ready = True
            except Exception:
                # Live remains useful; readiness reports a safe 503.
                app.state.startup_ready = False
            app.state.repository = RunRepository(app.state.db)
            yield
        finally:
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
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

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
