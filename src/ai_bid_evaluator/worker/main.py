import argparse
import asyncio
from pathlib import Path
from dataclasses import replace
from ai_bid_evaluator.config import load_settings
from ai_bid_evaluator.infrastructure.db import Database
from ai_bid_evaluator.infrastructure.repositories import RunRepository
from ai_bid_evaluator.infrastructure.model_cache import ModelCache
from ai_bid_evaluator.infrastructure.artifacts import ArtifactStore
from ai_bid_evaluator.services.llm_gateway import LLMGateway, BailianClient
from .runner import WorkerRunner


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


async def serve(settings, *, once=False):
    settings.project_root.joinpath("data").mkdir(parents=True, exist_ok=True)
    db = Database(settings.database_url)
    db.migrate()
    repository = RunRepository(db)
    gateway = make_gateway(settings, db)
    runner = make_runner(settings, repository, gateway)
    try:
        while True:
            await runner.run_once()
            if once:
                return
            await asyncio.sleep(settings.worker_poll_seconds)
    finally:
        await gateway.close()
        db.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="持久任务 worker（独立于 API）")
    parser.add_argument("--once", action="store_true", help="执行一个待运行任务后退出")
    parser.add_argument("--database")
    args = parser.parse_args(argv)
    settings = load_settings()
    if args.database:
        settings = replace(settings, database_url=args.database)
    try:
        asyncio.run(serve(settings, once=args.once))
    except KeyboardInterrupt:
        print("worker 已停止；未完成步骤在租约过期后恢复。")


if __name__ == "__main__":
    main()
