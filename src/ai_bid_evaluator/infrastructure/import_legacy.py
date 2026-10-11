import argparse
import json
from pathlib import Path
from uuid import uuid4
from ai_bid_evaluator.domain.run import RunState
from .orm_models import RunRow, RunStepRow
from .repositories import content_hash


def import_legacy(repository, path: Path, project_id: str) -> RunState:
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("旧结果顶层必须是对象")
    state = RunState(run_id=f"import_{uuid4().hex}", type="bid_evaluation", project_id=project_id,
                     status="awaiting_review", current_step="legacy", review_count=1, result_stale=True,
                     known_steps=["legacy"], completed_steps=["legacy"], input_snapshot={"legacy_hash": content_hash(data)})
    with repository.db.write() as session:
        session.add(RunRow(run_id=state.run_id, project_id=project_id, type=state.type, status=state.status, data=state.model_dump(mode="json")))
        session.flush()
        session.add(RunStepRow(run_id=state.run_id, name="legacy", data={"output": data, "stale": False, "confirmed": False, "output_hash": content_hash(data)}))
    return state


def main():
    from .db import Database
    from .repositories import RunRepository
    parser = argparse.ArgumentParser(description="导入旧 JSON，保留原文件，需人工复核")
    parser.add_argument("source", type=Path)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--database", default="sqlite:///data/backend.db")
    args = parser.parse_args()
    db = Database(args.database)
    try:
        db.migrate()
        run = import_legacy(RunRepository(db), args.source, args.project_id)
        print(run.run_id)
    finally:
        db.close()


if __name__ == "__main__":
    main()
