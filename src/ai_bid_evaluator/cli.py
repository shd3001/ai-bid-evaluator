"""Compatibility CLI consumes the same durable services as future API routes."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4
from dataclasses import replace
from pydantic import ValidationError
from ai_bid_evaluator.config import load_settings
from ai_bid_evaluator.domain.run import ReviewDecision
from ai_bid_evaluator.domain.exceptions import DomainError
from ai_bid_evaluator.infrastructure.db import Database
from ai_bid_evaluator.infrastructure.repositories import RunRepository
from ai_bid_evaluator.infrastructure.artifacts import ArtifactStore
from ai_bid_evaluator.application.cli_service import submit_legacy_input
from ai_bid_evaluator.application.review_service import ReviewService, EDIT_FIELDS
from ai_bid_evaluator.worker.main import make_gateway, make_runner


async def run_cli(run_type, argv=None):
    parser = argparse.ArgumentParser(description="招投标辅助评审，可保存复核后继续")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--run-id", help="继续已有任务，不重新读取原始材料")
    parser.add_argument("--submit-only", action="store_true", help="只登记任务，由独立 worker 执行")
    parser.add_argument("--idempotency-key")
    parser.add_argument("--database")
    args = parser.parse_args(argv)
    settings = load_settings()
    if args.database:
        settings = replace(settings, database_url=args.database)
    settings.project_root.joinpath("data").mkdir(parents=True, exist_ok=True)
    db = Database(settings.database_url)
    db.migrate()
    repository = RunRepository(db)
    store = ArtifactStore(settings.project_root / "data" / "runs")
    gateway = make_gateway(settings, db)
    try:
        if args.run_id:
            state = repository.load(args.run_id)
            if state.type != run_type:
                raise DomainError("任务类型与入口不匹配")
        else:
            env, filename = ("BID_EVAL_INPUT", "bid_eval_input.json") if run_type == "bid_evaluation" else ("OPPORTUNITY_INPUT", "opportunity_input.json")
            path = args.input or Path(os.getenv(env, str(settings.project_root / "data" / filename)))
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            state = await submit_legacy_input(repository, settings.project_root, raw, run_type, args.idempotency_key or f"cli_{uuid4().hex}")
        print(f"run_id: {state.run_id}")
        if args.submit_only:
            print(f"状态：{state.status}，可由独立 worker 继续。")
            return
        runner = make_runner(settings, repository, gateway)
        while True:
            if state.status in {"pending", "running"}:
                advanced = await runner.run_once(state.run_id)
                state = advanced or repository.load(state.run_id)
            if state.status != "awaiting_review":
                print(f"状态：{state.status}；产物：data/runs/{state.run_id}/")
                if state.error:
                    print(json.dumps(state.error, ensure_ascii=False))
                return
            output = repository.steps(state.run_id)[state.current_step]["output"]
            store.write_json(state.run_id, state.current_step, output)
            review_path = store.path(state.run_id, "review_request")
            if not review_path.exists():
                store.write_json(state.run_id, "review_request", {"decision": "confirm", "target_id": state.current_step,
                    "patch": {}, "reason": "", "actor": "local_user", "expected_version": state.revision})
            print(f"等待复核步骤：{state.current_step}；请求文件：{review_path}")
            if settings.auto_yes:
                print("AUTO_YES 不自动确认资格或规则；请填写复核文件后使用 --run-id 继续。")
                return
            response = await asyncio.to_thread(input, "检查步骤产物，修改 review_request.json 并填写理由；回车提交，q 暂存：")
            if response.strip().lower() == "q":
                return
            try:
                decision = ReviewDecision.model_validate(json.loads(review_path.read_text(encoding="utf-8-sig")))
                state = ReviewService(repository).apply(state.run_id, decision, f"review_{uuid4().hex}")
                review_path.unlink(missing_ok=True)
            except (DomainError, ValidationError, ValueError) as exc:
                print(f"复核未提交：{type(exc).__name__}。请核对理由、版本、ID、数值和证据。")
    finally:
        await gateway.close()
        db.close()
