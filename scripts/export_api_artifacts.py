"""Export the current contract and synthetic API examples without paid clients."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from fastapi.testclient import TestClient
from ai_bid_evaluator.config import Settings
from ai_bid_evaluator.api.app import create_app


def export(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as folder:
        root = Path(folder)
        settings = Settings(project_root=root, api_key="", base_url="https://example.invalid", doc_model="fake", agent_model="fake",
            retry_count=1, retry_seconds=0, database_url=f"sqlite:///{(root/'export.db').as_posix()}")
        with TestClient(create_app(settings)) as client:
            schema = client.get("/openapi.json").json()
            project = client.post("/api/v1/projects", json={"name": "合成示例项目"}).json()
            document = client.post("/api/v1/documents", data={"project_id": project["project_id"], "role": "profile"},
                files={"file": ("synthetic.md", "示例企业持有施工资质".encode("utf-8"), "text/plain")}).json()
            request = {"type": "opportunity_discovery", "project_id": project["project_id"], "document_ids": [document["document_id"]],
                       "options": {"regions": ["江苏"], "min_budget": "1000000", "max_candidates": 5}}
            run = client.post("/api/v1/runs", headers={"Idempotency-Key": "synthetic-example"}, json=request).json()
            chunks = client.get(f"/api/v1/documents/{document['document_id']}/chunks").json()
            error = client.post("/api/v1/runs", json=request).json()
            samples = {"synthetic": True, "project_response": project, "document_response": document, "chunks_response": chunks,
                       "run_request": request, "run_response": run, "validation_error": error,
                       "review_request": {"decision": "confirm", "target_id": "profile", "patch": {}, "reason": "已核对原文",
                                          "expected_version": 4}}
        (destination / "openapi.json").write_text(json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8")
        (destination / "api-examples.json").write_text(json.dumps(samples, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"paths": len(schema["paths"]), "schemas": len(schema["components"]["schemas"]), "output": str(destination)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs")
    export(parser.parse_args().output)
