"""Local acceptance server: real API/worker, synthetic external services, isolated DB.

Run from repository root. Never uses the normal database or credentials.
"""
import argparse
import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]

from fastapi.staticfiles import StaticFiles
import uvicorn
from ai_bid_evaluator.api.app import create_app
from ai_bid_evaluator.config import Settings
from ai_bid_evaluator.services.llm_gateway import LLMGateway
from ai_bid_evaluator.worker.runner import WorkerRunner
from ai_bid_evaluator.workflows.opportunity_discovery import OpportunityDiscoveryWorkflow
from ai_bid_evaluator.workflows.bid_evaluation import BidEvaluationWorkflow
from tests.workflow_fakes import FakeModel, FakeSearch, FakeCrawler


def acceptance_app(work):
    settings = Settings(project_root=work, api_key="", base_url="https://example.invalid",
                        doc_model="fake", agent_model="fake", retry_count=1, retry_seconds=0,
                        database_url=f"sqlite:///{(work / 'state.db').as_posix()}")
    app = create_app(settings)
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with original(app):
            gateway = LLMGateway(FakeModel(), max_attempts=1)
            repo = app.state.repository
            flow = OpportunityDiscoveryWorkflow(repo, gateway, searcher=FakeSearch(),
                                                crawler=FakeCrawler(work), settings=settings)
            runner = WorkerRunner(repo, gateway, workflows={"opportunity_discovery": flow,
                                  "bid_evaluation": BidEvaluationWorkflow(repo, gateway)})

            async def consume():
                while True:
                    await runner.run_once()
                    await asyncio.sleep(0.1)

            task = asyncio.create_task(consume())
            try:
                yield
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    app.router.lifespan_context = lifespan
    app.mount("/", StaticFiles(directory=ROOT / "frontend" / "dist", html=True))
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="bid-acceptance-") as directory:
        uvicorn.run(acceptance_app(Path(directory)), host="127.0.0.1", port=args.port)
