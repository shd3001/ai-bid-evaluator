"""统一日志：单行结构化输出，带请求与任务上下文。

设计要点：

* 一条日志一行，默认 JSON（便于 ``journalctl -o cat`` / 文件采集），
  ``LOG_FORMAT=text`` 时可读性更好，适合本机开发。
* 请求 ID 通过 contextvar 传递，避免每个调用点手动塞 ``extra``。
* ``configure_logging`` 幂等：重复调用（例如测试里多次 create_app）不会叠加 handler。
* 只记录结构化字段，不打印请求头、请求体或模型提示词，避免密钥/材料泄漏。
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import sys
import threading
from datetime import datetime, timezone

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
run_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("run_id", default=None)

# LogRecord 的内置属性，不应被当作业务字段重复输出。
_STANDARD_ATTRS = frozenset({
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename", "module",
    "exc_info", "exc_text", "stack_info", "lineno", "funcName", "created", "msecs",
    "relativeCreated", "thread", "threadName", "processName", "process", "taskName",
    "message", "asctime", "request_id", "run_id", "color_message",
})

_LOCK = threading.Lock()
_configured = False


def _timestamp(created: float) -> str:
    return datetime.fromtimestamp(created, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _context(record: logging.LogRecord) -> dict[str, str]:
    values: dict[str, str] = {}
    request_id = getattr(record, "request_id", None) or request_id_var.get()
    run_id = getattr(record, "run_id", None) or run_id_var.get()
    if request_id:
        values["request_id"] = str(request_id)
    if run_id:
        values["run_id"] = str(run_id)
    return values


class JsonFormatter(logging.Formatter):
    """把一条日志序列化成单行 JSON。"""

    def __init__(self, service: str = "app") -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": _timestamp(record.created),
            "level": record.levelname,
            "service": self.service,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        payload.update(_context(record))
        for key, value in record.__dict__.items():
            if key in _STANDARD_ATTRS or key.startswith("_") or key in payload:
                continue
            payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


class TextFormatter(logging.Formatter):
    """面向本机终端的人类可读格式。"""

    def __init__(self, service: str = "app") -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        parts = [self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"), record.levelname.ljust(5), self.service, record.name]
        context = " ".join(f"{key}={value}" for key, value in _context(record).items())
        if context:
            parts.append(context)
        line = f"{' '.join(parts)} | {record.getMessage()}"
        extras = []
        for key, value in record.__dict__.items():
            if key in _STANDARD_ATTRS or key.startswith("_") or key in ("request_id", "run_id"):
                continue
            extras.append(f"{key}={value}")
        if extras:
            line = f"{line} | {' '.join(extras)}"
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        return line


def configure_logging(
    service: str,
    *,
    level: str | None = None,
    fmt: str | None = None,
    stream=None,
    force: bool = False,
) -> logging.Logger:
    """给根 logger 安装 handler，并把 uvicorn 日志并入同一格式。

    幂等：进程内重复调用只调整级别，不会重复挂载 handler。
    ``LOG_LEVEL`` 默认 INFO，``LOG_FORMAT`` 取 json/text。
    """
    global _configured
    level_name = (level or os.getenv("LOG_LEVEL") or "INFO").strip().upper()
    level_value = getattr(logging, level_name, logging.INFO)
    output = (fmt or os.getenv("LOG_FORMAT") or "json").strip().lower()
    target = stream if stream is not None else sys.stdout

    with _LOCK:
        root = logging.getLogger()
        existing = [handler for handler in root.handlers if getattr(handler, "_ai_bid_handler", False)]
        if not _configured or force:
            # force 用于把日志重定向到新流/新格式（自检、脚本、测试隔离），必须替换而非复用。
            if force:
                for handler in existing:
                    root.removeHandler(handler)
                    handler.close()
                existing = []
            if not existing:
                handler = logging.StreamHandler(target)
                handler.setFormatter(TextFormatter(service) if output == "text" else JsonFormatter(service))
                handler._ai_bid_handler = True  # type: ignore[attr-defined]
                root.addHandler(handler)
            # uvicorn 默认自带 handler，接管后统一走 JSON/文本格式。
            for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
                uv = logging.getLogger(name)
                uv.handlers.clear()
                uv.propagate = True
            # 抓取/模型请求量很大，默认只保留告警，排查时用 LOG_HTTPX_LEVEL=INFO 打开。
            logging.getLogger("httpx").setLevel(getattr(logging, os.getenv("LOG_HTTPX_LEVEL", "WARNING").upper(), logging.WARNING))
            logging.getLogger("httpcore").setLevel(logging.WARNING)
            logging.getLogger("python_multipart").setLevel(logging.WARNING)
            # 迁移器只在首次建表时打一堆 INFO，运行时没有价值。
            logging.getLogger("alembic").setLevel(logging.WARNING)
            # 访问日志已由请求中间件输出（含 request_id/耗时），避免每条请求打两遍。
            access_level = getattr(logging, os.getenv("LOG_UVICORN_ACCESS_LEVEL", "WARNING").upper(), logging.WARNING)
            logging.getLogger("uvicorn.access").setLevel(access_level)
            _configured = True
        root.setLevel(level_value)
        return logging.getLogger(service)


def is_configured() -> bool:
    return _configured