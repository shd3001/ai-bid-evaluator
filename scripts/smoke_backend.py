"""Check real localhost HTTP and an empty independent worker using a temporary DB."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
import httpx


def main():
    root = Path(__file__).resolve().parents[1]
    with TemporaryDirectory(dir=root / ".verification") as folder:
        work = Path(folder)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        environment = {**os.environ, "DATABASE_URL": f"sqlite:///{(work/'smoke.db').as_posix()}", "DASHSCOPE_API_KEY": ""}
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with (work / "server.log").open("w", encoding="utf-8") as log:
            server = subprocess.Popen([sys.executable, "-m", "uvicorn", "ai_bid_evaluator.api.app:create_app", "--factory",
                "--host", "127.0.0.1", "--port", str(port)], cwd=root, env=environment, stdout=log, stderr=log, creationflags=flags)
            try:
                with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=10, trust_env=False) as client:
                    deadline = time.monotonic() + 20
                    while True:
                        try:
                            ready = client.get("/api/v1/health/ready")
                            if ready.status_code == 200:
                                break
                        except httpx.HTTPError:
                            pass
                        if time.monotonic() >= deadline or server.poll() is not None:
                            raise RuntimeError("本机 API 未成功就绪")
                        time.sleep(0.1)
                    assert client.get("/api/v1/health/live").status_code == 200
                    assert client.get("/openapi.json").status_code == 200
                    project = client.post("/api/v1/projects", json={"name": "本机启停验证"})
                    assert project.status_code == 201
                    pid = project.json()["project_id"]
                    doc = client.post("/api/v1/documents", data={"project_id": pid, "role": "profile"},
                        files={"file": ("synthetic.md", "合成企业施工资质".encode(), "text/plain")})
                    assert doc.status_code == 201
                    run = client.post("/api/v1/runs", headers={"Idempotency-Key": "smoke"}, json={"project_id": pid,
                        "type": "opportunity_discovery", "document_ids": [doc.json()["document_id"]]})
                    assert run.status_code == 202 and run.json()["status"] == "pending"
                    cancelled = client.post(run.headers["Location"] + "/cancel", headers={"Idempotency-Key": "cancel"},
                        json={"expected_version": run.json()["revision"]})
                    assert cancelled.status_code == 202 and cancelled.json()["status"] == "cancelled"
                worker = subprocess.run([sys.executable, "-m", "ai_bid_evaluator.worker.main", "--once"],
                    cwd=root, env=environment, capture_output=True, timeout=20, creationflags=flags)
                assert worker.returncode == 0, "空队列 worker 启停失败"
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)
        print(json.dumps({"real_http": True, "upload_and_pending": True, "cancel": True, "empty_worker": True, "server_stopped": True}))


if __name__ == "__main__":
    main()
