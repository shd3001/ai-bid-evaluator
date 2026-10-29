import argparse
import asyncio
import logging
import os
import signal
from contextlib import suppress
from dataclasses import replace
from ai_bid_evaluator.config import load_settings
from ai_bid_evaluator.logging_setup import configure_logging
from ai_bid_evaluator.infrastructure.db import Database
from ai_bid_evaluator.infrastructure.repositories import RunRepository
from ai_bid_evaluator.infrastructure.model_cache import ModelCache
from ai_bid_evaluator.infrastructure.artifacts import ArtifactStore
from ai_bid_evaluator.services.llm_gateway import LLMGateway, BailianClient
from .runner import WorkerRunner

logger = logging.getLogger("ai_bid_evaluator.worker")


def make_gateway(settings, db):
    return LLMGateway(BailianClient(settings), model=settings.doc_model, max_attempts=settings.retry_count,
                      retry_seconds=settings.retry_seconds, timeout_seconds=settings.model_timeout_seconds, cache=ModelCache(db))


def make_runner(settings, repository, gateway):
    from ai_bid_evaluator.workflows.bid_evaluation import BidEvaluationWorkflow
    from ai_bid_evaluator.workflows.opportunity_discovery import OpportunityDiscoveryWorkflow
    flows = {"bid_evaluation": BidEvaluationWorkflow(repository, gateway, max_tokens=settings.chunk_max_tokens),
             "opportunity_discovery": OpportunityDiscoveryWorkflow(repository, gateway, settings=settings, max_tokens=settings.chunk_max_tokens)}
    return WorkerRunner(repository, gateway, workflows=flows, lease_seconds=settings.lease_seconds,
                        heartbeat_seconds=settings.heartbeat_seconds, artifacts=ArtifactStore(settings.project_root / "data" / "runs"))


def install_stop_handlers(stop: asyncio.Event) -> list[str]:
    """把 SIGTERM/SIGINT/SIGBREAK 转成优雅停机信号。

    优先使用事件循环的信号处理；Windows 的 Proactor 循环不支持
    ``add_signal_handler``，退回 ``signal.signal``（仅主线程可用）。
    Windows 下 CTRL_C 对新进程组默认禁用，CTRL_BREAK（SIGBREAK）是可用的软停机信号。
    """
    loop = asyncio.get_running_loop()
    installed = []
    signals = [signal.SIGTERM, signal.SIGINT]
    if hasattr(signal, "SIGBREAK"):
        signals.append(signal.SIGBREAK)
    for sig in signals:
        try:
            loop.add_signal_handler(sig, stop.set)
            installed.append(sig.name)
            continue
        except (NotImplementedError, RuntimeError, ValueError):
            pass
        try:
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
            installed.append(sig.name)
        except (ValueError, OSError):
            logger.warning("stop_handler_unavailable", extra={"signal": sig.name})
    logger.info("stop_handlers_installed", extra={"signals": installed})
    return installed


async def run_iteration(runner, stop: asyncio.Event):
    """跑一轮任务；若停机信号先到，则取消本轮并等待其收尾。"""
    run_task = asyncio.create_task(runner.run_once())
    stop_task = asyncio.create_task(stop.wait())
    try:
        done, _ = await asyncio.wait({run_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
        if run_task in done:
            return run_task.result()
        if not run_task.done():
            # 取消会被 runner 转成"保留租约"的干净中断，任务在租约过期后由下一个 worker 续跑。
            logger.warning("shutdown_draining", extra={"action": "cancel_inflight_run"})
            run_task.cancel()
            with suppress(asyncio.CancelledError):
                await run_task
        return None
    finally:
        stop_task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await stop_task
        if not run_task.done():
            run_task.cancel()


async def serve(settings, *, once=False, stop: asyncio.Event | None = None, runner=None):
    configure_logging("worker")
    stop = stop if stop is not None else asyncio.Event()
    settings.project_root.joinpath("data").mkdir(parents=True, exist_ok=True)
    db = Database(settings.database_url)
    db.migrate()
    repository = RunRepository(db)
    gateway = make_gateway(settings, db)
    runner = runner if runner is not None else make_runner(settings, repository, gateway)
    logger.info("worker_starting", extra={"pid": os.getpid(), "database": settings.database_url,
                                          "model": settings.doc_model, "poll_seconds": settings.worker_poll_seconds,
                                          "lease_seconds": settings.lease_seconds})
    if not settings.api_key:
        logger.warning("model_key_missing", extra={"hint": "DASHSCOPE_API_KEY 未配置，模型步骤会直接失败"})
    try:
        install_stop_handlers(stop)
        while not stop.is_set():
            try:
                state = await run_iteration(runner, stop)
            except Exception:
                logger.exception("worker_iteration_failed")
                state = None
            if state is not None:
                logger.info("run_finished", extra={"run_id": state.run_id, "status": state.status})
            if once:
                return state
            if stop.is_set():
                break
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=settings.worker_poll_seconds)
    finally:
        logger.info("worker_stopping")
        await gateway.close()
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="持久任务 worker（独立于 API）")
    parser.add_argument("--once", action="store_true", help="执行一个待运行任务后退出")
    parser.add_argument("--database")
    args = parser.parse_args(argv)
    configure_logging("worker")
    settings = load_settings()
    if args.database:
        settings = replace(settings, database_url=args.database)
    try:
        asyncio.run(serve(settings, once=args.once))
    except KeyboardInterrupt:
        # 正常情况下 SIGINT 已被 install_stop_handlers 接管，这里只兜底极早期中断。
        logger.warning("worker_interrupted")
    logger.info("worker_exit")


if __name__ == "__main__":
    main()
