import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    project_root: Path
    api_key: str
    base_url: str
    doc_model: str
    agent_model: str
    retry_count: int
    retry_seconds: float
    # 投标机会搜索功能配置
    search_api_key: str = ""
    search_api_base: str = "https://api.bochaai.com"
    max_candidates: int = 5
    search_providers: str = "bocha,ccgp"
    crawl_timeout_seconds: float = 20.0
    auto_yes: bool = False
    database_url: str = "sqlite:///data/backend.db"
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    model_timeout_seconds: float = 120.0
    lease_seconds: int = 120
    heartbeat_seconds: float = 30.0
    upload_limit_bytes: int = 50 * 1024 * 1024
    chunk_max_tokens: int = 8000
    worker_poll_seconds: float = 1.0


def load_settings(*, require_api_key: bool = False) -> Settings:
    project_root = Path(__file__).resolve().parents[2]
    load_dotenv(project_root / ".env")

    api_key = os.getenv("DASHSCOPE_API_KEY", "")
    if require_api_key and not api_key:
        raise RuntimeError("缺少环境变量 DASHSCOPE_API_KEY，请在 .env 中配置")

    def _int_env(key: str, default: int) -> int:
        value = os.getenv(key)
        if value is None or value.strip() == "":
            return default
        return int(value)

    def _float_env(key: str, default: float) -> float:
        value = os.getenv(key)
        if value is None or value.strip() == "":
            return default
        return float(value)

    def _bool_env(key: str, default: bool) -> bool:
        value = os.getenv(key)
        if value is None or value.strip() == "":
            return default
        return value.strip().lower() in ("1", "true", "yes", "on")

    return Settings(
        project_root=project_root,
        api_key=api_key,
        base_url=os.getenv("BAILIAN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        doc_model=os.getenv("BAILIAN_DOC_MODEL", "qwen-long"),
        agent_model=os.getenv("BAILIAN_AGENT_MODEL", "qwen3.7-plus"),
        retry_count=int(os.getenv("BAILIAN_RETRY_COUNT", "5")),
        retry_seconds=float(os.getenv("BAILIAN_RETRY_SECONDS", "8")),
        search_api_key=os.getenv("SEARCH_API_KEY") or os.getenv("BOCHA_API_KEY") or "",
        search_api_base=os.getenv("SEARCH_API_BASE", "https://api.bochaai.com"),
        max_candidates=_int_env("MAX_CANDIDATES", 5),
        search_providers=os.getenv("SEARCH_PROVIDERS", "bocha,ccgp"),
        crawl_timeout_seconds=_float_env("CRAWL_TIMEOUT_SECONDS", 20.0),
        auto_yes=_bool_env("AUTO_YES", False),
        database_url=os.getenv("DATABASE_URL", f"sqlite:///{(project_root / 'data' / 'backend.db').as_posix()}"),
        cors_origins=tuple(o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()),
        model_timeout_seconds=_float_env("MODEL_TIMEOUT_SECONDS", 120.0),
        lease_seconds=_int_env("WORKER_LEASE_SECONDS", 120),
        heartbeat_seconds=_float_env("WORKER_HEARTBEAT_SECONDS", 30.0),
        chunk_max_tokens=_int_env("CHUNK_MAX_TOKENS", 8000),
        upload_limit_bytes=_int_env("UPLOAD_LIMIT_BYTES", 50 * 1024 * 1024),
        worker_poll_seconds=_float_env("WORKER_POLL_SECONDS", 1.0),
    )
