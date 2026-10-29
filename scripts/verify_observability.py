"""可观测性与优雅停机自检。

仓库内没有单元测试目录（第五阶段验收工具已在收尾时删除），
所以这里用可重复执行的脚本代替：

1. JSON / 文本两种日志格式是否可解析、字段是否齐全；
2. 请求 ID 是否贯穿日志与响应头；
3. API 启动、迁移、缺密钥告警、访问日志、错误日志是否落盘；
4. worker 停机信号是否能中断执行中的任务并退出；
5. 任务被中断时是否保留租约（不写 failed、不误标完成）；
6. 真实 worker 子进程收到系统停机信号后是否以退出码 0 结束。

用法（仓库根目录）：

    .venv/Scripts/python.exe scripts/verify_observability.py
"""

from __future__ import annotations

import asyncio
import functools
import io
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time
import types
import warnings
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
# fastapi.testclient 会带一条 httpx/starlette 弃用提示，与本脚本无关。
warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient`")

from ai_bid_evaluator.config import load_settings  # noqa: E402
from ai_bid_evaluator.domain.run import RunState  # noqa: E402
from ai_bid_evaluator.logging_setup import (  # noqa: E402
    configure_logging,
    request_id_var,
    run_id_var,
)
from ai_bid_evaluator.worker.runner import WorkerRunner  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> None:
    try:
        detail = fn()
    except Exception as exc:  # noqa: BLE001 - 自检脚本需要报告任意失败
        RESULTS.append((name, False, f"{type(exc).__name__}: {exc}"))
        print(f"[FAIL] {name}: {type(exc).__name__}: {exc}")
        return
    RESULTS.append((name, True, ""))
    print(f"[PASS] {name}" + (f" -> {detail}" if detail else ""))


class Captured:
    """把日志写进内存，便于断言。"""

    def __init__(self) -> None:
        self.buffer = io.StringIO()

    def lines(self) -> list[dict]:
        parsed = []
        for line in self.buffer.getvalue().splitlines():
            line = line.strip()
            if not line:
                continue
            parsed.append(json.loads(line))
        return parsed

    def find(self, msg: str) -> list[dict]:
        return [item for item in self.lines() if item.get("msg") == msg]


def json_logging_shape() -> str:
    captured = Captured()
    configure_logging("verify", fmt="json", stream=captured.buffer, force=True)
    logger = logging.getLogger("verify.probe")
    token = request_id_var.set("req_test")
    try:
        logger.info("probe_message", extra={"custom_field": "custom_value"})
    finally:
        request_id_var.reset(token)
    run_token = run_id_var.set("run_test")
    try:
        logger.info("probe_run")
    finally:
        run_id_var.reset(run_token)
    try:
        raise RuntimeError("boom")
    except RuntimeError:
        logger.exception("probe_exception")

    records = captured.lines()
    first = next(item for item in records if item["msg"] == "probe_message")
    for key in ("ts", "level", "service", "logger", "msg"):
        assert key in first, f"缺少字段 {key}"
    assert first["service"] == "verify", first
    assert first["request_id"] == "req_test", first
    assert first["custom_field"] == "custom_value", first
    assert next(item for item in records if item["msg"] == "probe_run")["run_id"] == "run_test"
    exception_record = next(item for item in records if item["msg"] == "probe_exception")
    assert "RuntimeError: boom" in exception_record.get("exc", ""), exception_record
    return f"{len(records)} 条 JSON 日志，含 request_id/run_id/堆栈"


def api_logging() -> str:
    from fastapi.testclient import TestClient
    from ai_bid_evaluator.api.app import create_app

    captured = Captured()
    configure_logging("api", fmt="json", stream=captured.buffer, force=True)
    tmpdir = tempfile.mkdtemp(prefix="bid-verify-")
    settings = replace(load_settings(), database_url=f"sqlite:///{(Path(tmpdir) / 'verify.db').as_posix()}", api_key="")
    app = create_app(settings)
    with TestClient(app) as client:
        live = client.get("/api/v1/health/live", headers={"X-Request-ID": "req_client_1"})
        assert live.status_code == 200, live.text
        assert live.headers.get("X-Request-ID") == "req_client_1"
        ready = client.get("/api/v1/health/ready")
        assert ready.status_code == 200, ready.text
        missing = client.get("/api/v1/unknown")
        assert missing.status_code == 404, missing.status_code

    records = captured.lines()
    assert any(item["msg"] == "api_starting" for item in records), records
    assert any(item["msg"] == "database_ready" for item in records), records
    assert any(item["msg"] == "model_key_missing" for item in records), "缺少模型密钥时应有告警"
    access = [item for item in records if item["msg"] == "http_request"]
    assert len(access) >= 3, access
    live_record = next(item for item in access if item.get("path") == "/api/v1/health/live")
    assert live_record["status"] == 200 and live_record["request_id"] == "req_client_1", live_record
    assert isinstance(live_record["duration_ms"], (int, float)), live_record
    assert any(item.get("status") == 404 for item in access), access
    handlers = [h for h in logging.getLogger().handlers if getattr(h, "_ai_bid_handler", False)]
    assert len(handlers) == 1, f"handler 重复挂载: {len(handlers)}"
    return f"启动/迁移/缺密钥/访问日志齐全，{len(access)} 条 http_request"


def worker_serve_stop() -> str:
    from ai_bid_evaluator.worker.main import serve

    tmpdir = tempfile.mkdtemp(prefix="bid-verify-worker-")
    settings = replace(load_settings(), database_url=f"sqlite:///{(Path(tmpdir) / 'worker.db').as_posix()}")
    captured = Captured()
    configure_logging("worker", fmt="json", stream=captured.buffer, force=True)

    async def scenario() -> float:
        stop = asyncio.Event()

        async def never_finishes():
            await asyncio.sleep(30)
            return None

        runner = types.SimpleNamespace(run_once=never_finishes)
        task = asyncio.create_task(serve(settings, stop=stop, runner=runner))
        await asyncio.sleep(0.6)
        assert not task.done(), "worker 不应在空闲时退出"
        started = asyncio.get_running_loop().time()
        stop.set()
        await asyncio.wait_for(task, timeout=5)
        return asyncio.get_running_loop().time() - started

    elapsed = asyncio.run(scenario())
    records = captured.lines()
    assert any(item["msg"] == "worker_starting" for item in records), records
    assert any(item["msg"] == "stop_handlers_installed" for item in records), records
    assert any(item["msg"] == "shutdown_draining" for item in records), "停机时应取消执行中的任务"
    assert any(item["msg"] == "worker_stopping" for item in records), records
    return f"收到停机信号后 {elapsed:.2f}s 内退出并清理资源"


def interrupt_keeps_lease() -> str:
    class FakeRepository:
        def __init__(self, state):
            self.state, self.failed_at, self.finished_at, self.checkpoints = state, None, None, 0

        def claim_next(self, owner, now, lease_seconds, run_id=None):
            return self.state

        def load(self, run_id):
            return self.state

        def steps(self, run_id):
            return {}

        def begin_step(self, *args, **kwargs):
            return self.state

        def checkpoint(self, *args, **kwargs):
            self.checkpoints += 1
            return self.state

        def fail(self, run_id, owner, code):
            self.failed_at = code
            return self.state

        def finish(self, run_id, owner):
            self.finished_at = owner
            return self.state

        def renew_lease(self, *args, **kwargs):
            return self.state

    started = asyncio.Event()

    class SlowWorkflow:
        def __init__(self):
            self.cancelled = False

        async def execute(self, name, state, outputs):
            started.set()
            try:
                await asyncio.sleep(30)
            finally:
                self.cancelled = True
            return types.SimpleNamespace(output={}, awaiting_review=False)

    async def scenario() -> tuple[FakeRepository, SlowWorkflow]:
        state = RunState(run_id="run_1", type="bid_evaluation", project_id="prj_1", status="running",
                         owner="worker_test", known_steps=["extract"], completed_steps=[])
        repository = FakeRepository(state)
        workflow = SlowWorkflow()
        runner = WorkerRunner(repository, None, workflows={"bid_evaluation": workflow},
                              owner="worker_test", lease_seconds=120, heartbeat_seconds=30)
        task = asyncio.create_task(runner.run_once())
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return repository, workflow

    repository, workflow = asyncio.run(scenario())
    assert workflow.cancelled, "执行中的步骤应被取消"
    assert repository.failed_at is None, f"中断不应写 failed: {repository.failed_at}"
    assert repository.finished_at is None, "中断不应把任务标记完成"
    assert repository.checkpoints == 0, "中断不应写入检查点"
    assert repository.state.status == "running", repository.state.status
    return "中断后保留租约，未写 failed/checkpoint"


def signal_sets_stop(sig: int) -> str:
    from ai_bid_evaluator.worker.main import install_stop_handlers

    async def scenario() -> bool:
        stop = asyncio.Event()
        install_stop_handlers(stop)
        signal.raise_signal(sig)
        await asyncio.sleep(0.2)
        return stop.is_set()

    try:
        stopped = asyncio.run(scenario())
    finally:
        for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
            number = getattr(signal, name, None)
            if number is not None:
                signal.signal(number, signal.SIG_DFL)
    assert stopped, f"{getattr(sig, 'name', sig)} 未触发停机事件"
    return f"{getattr(sig, 'name', sig)} 成功转换为停机事件"


def worker_process_stop() -> str:
    """真实子进程验证：worker 收到系统停机信号后应清理并退出。"""
    tmpdir = Path(tempfile.mkdtemp(prefix="bid-verify-proc-"))
    database = f"sqlite:///{(tmpdir / 'worker.db').as_posix()}"
    log_path = tmpdir / "worker.log"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", LOG_FORMAT="json")
    with open(log_path, "w", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            [sys.executable, "-m", "ai_bid_evaluator.worker.main", "--database", database],
            cwd=str(ROOT), stdout=log_file, stderr=subprocess.STDOUT, env=env,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            text = log_path.read_text(encoding="utf-8", errors="replace")
            if '"msg": "worker_starting"' in text:
                break
            assert process.poll() is None, f"worker 启动失败:\n{text}"
            time.sleep(0.2)
        else:
            raise AssertionError("worker 60s 内未进入就绪状态")
        # Windows 下 CTRL_C 对新进程组默认禁用，软停机信号是 CTRL_BREAK。
        process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
        code = process.wait(timeout=60)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
    text = log_path.read_text(encoding="utf-8", errors="replace")
    assert code == 0, f"退出码 {code}:\n{text}"
    assert '"msg": "worker_stopping"' in text, text
    assert '"msg": "worker_exit"' in text, text
    return f"子进程 pid={process.pid} 停机后退出码 0，日志含 worker_stopping/worker_exit"


def text_logging() -> str:
    captured = Captured()
    configure_logging("verify", fmt="text", stream=captured.buffer, force=True)
    logging.getLogger("verify.text").info("probe_text", extra={"step": "extract"})
    output = captured.buffer.getvalue()
    assert "| probe_text" in output, output
    assert "step=extract" in output, output
    return "文本格式包含上下文与结构化字段"


def main() -> int:
    print(f"Python {sys.version.split()[0]} | cwd={os.getcwd()}")
    check("JSON 日志字段与上下文", json_logging_shape)
    check("API 启动/访问/错误日志", api_logging)
    check("worker 优雅停机", worker_serve_stop)
    check("中断保留租约", interrupt_keeps_lease)
    check("SIGTERM 触发停机", functools.partial(signal_sets_stop, signal.SIGTERM))
    if hasattr(signal, "SIGBREAK"):
        check("SIGBREAK 触发停机", functools.partial(signal_sets_stop, signal.SIGBREAK))
    check("worker 子进程停机退出", worker_process_stop)
    check("文本日志格式", text_logging)

    failed = [name for name, ok, _ in RESULTS if not ok]
    print("-" * 60)
    if failed:
        print(f"FAILED {len(failed)}/{len(RESULTS)}: {', '.join(failed)}")
        return 1
    print(f"OK {len(RESULTS)}/{len(RESULTS)} 项通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())