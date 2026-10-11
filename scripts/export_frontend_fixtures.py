#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""导出前端离线演示夹具（frontend/src/demo/fixtures）。

设计要点
--------
* 完全离线：只使用 ``TestClient(create_app(settings))`` 走真实 HTTP 接口，
  模型与搜索使用 ``tests/workflow_fakes.py`` 里的 fake 实现（无网络、无 Key）。
* 独立数据库：写在 ``data/frontend-fixtures/state.db``，不触碰 ``data/backend.db``
  以及仓库里已有的任何数据库；工作目录 ``data/frontend-fixtures/_work/`` 每次清空。
* 造数链路（两条，均跑到 ``succeeded``）：
  1. ``bid_evaluation``：公告 + 招标文件 + 2 家投标人（每个投标人 1 份材料），
     模型首次返回非法 JSON 触发一次 ``awaiting_review`` 复核；确认后再做一次
     "改分 / 重排" 的 edit 复核，使旧报告 stale，然后重跑得到最新报告。
  2. ``opportunity_discovery``：画像 → 人工确认 → 公司画像落库 → 结果 → 报告。
* 幂等可重跑：``Idempotency-Key`` 使用固定字符串，目标目录先整体清空；
  除 ``generated_at`` 与随机 id 外，产物内容稳定。
* 原样保存：所有后端响应 JSON 直接 dump，不改字段、不做归一化，
  保证数值仍是十进制字符串（如 "8.5"）、时间为带时区 ISO 8601。

产物结构
--------
::

    frontend/src/demo/fixtures/
      index.json                 总索引（projects/bidders/documents/runs/reports/companies）
      runs/<run_id>.json         {run, events, results, reviews, reports, report_details}
      documents/<document_id>.json  {document, chunks}
      README.md                  说明文件（由 README_TEXT 写入，幂等重建）

用无法从真实接口取得的字段一律写进 ``index.json`` 的 ``gaps``，绝不伪造。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------- 路径与导入
SCRIPT_PATH = Path(__file__).resolve()
PROJECT_ROOT = SCRIPT_PATH.parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
for candidate in (str(PROJECT_ROOT), str(SRC_ROOT)):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

from fastapi.testclient import TestClient  # noqa: E402

from ai_bid_evaluator.api.app import create_app  # noqa: E402
from ai_bid_evaluator.config import Settings  # noqa: E402
from ai_bid_evaluator.services.llm_gateway import LLMGateway  # noqa: E402
from ai_bid_evaluator.worker.runner import WorkerRunner  # noqa: E402
from ai_bid_evaluator.workflows.opportunity_discovery import OpportunityDiscoveryWorkflow  # noqa: E402

try:  # 允许通过 `python -m` 或任意工作目录执行
    from tests.workflow_fakes import (  # noqa: E402
        ANNOUNCEMENT_TEXT,
        BID_TEXTS,
        PROFILE_TEXT,
        TENDER_TEXT,
        FakeCrawler,
        FakeModel,
        FakeSearch,
    )
except ImportError as exc:  # pragma: no cover - 环境缺失时的明确提示
    raise SystemExit(
        "无法导入 tests/workflow_fakes.py，请确认在仓库根目录执行："
        f"\n  {SCRIPT_PATH}\n原始错误：{exc}"
    ) from exc

# ---------------------------------------------------------------- 常量
DEBUG = os.environ.get("FIXTURES_DEBUG") == "1"
OUTPUT_DIR = PROJECT_ROOT / "frontend" / "src" / "demo" / "fixtures"
WORK_DIR = PROJECT_ROOT / "data" / "frontend-fixtures"
DB_FILE = WORK_DIR / "state.db"
EPHEMERAL_DIR = WORK_DIR / "_work"

SOURCE_NOTE = "scripts/export_frontend_fixtures.py（离线 fake 模型/搜索，无网络）"
NOTICE = "合成材料，用于前端离线演示与截图验收；不代表真实脱敏材料验收。"

# 固定幂等键，保证每次运行的业务路径一致（提取出的 id 允许每次不同）。
KEY_BID_CREATE = "fixtures-bid-evaluation-create"
KEY_BID_FIX_RULES = "fixtures-bid-evaluation-fix-rules"
KEY_BID_CONFIRM_EXTRACT = "fixtures-bid-evaluation-confirm-extract"
KEY_BID_EDIT_ASSESS = "fixtures-bid-evaluation-edit-assess"
KEY_OPP_CREATE = "fixtures-opportunity-discovery-create"
KEY_OPP_CONFIRM_PROFILE = "fixtures-opportunity-discovery-confirm-profile"

# 合成的投标人名称（合成材料只有 2 份，见 tests/workflow_fakes.BID_TEXTS）：
# FakeModel 只对文本含 "BidA" 的材料给 8.5 分，含 "BidB" 的给 6.25 分，
# 因此两个投标人拿到两个不同分值，可用于演示排序与改分；
# 数量必须与 BID_TEXTS 一致，否则 zip 会静默截断（见 _check_fake_materials）。
BIDDER_NAMES = ["Bid0", "Bid1"]


def _check_fake_materials() -> None:
    """防止 fake 材料数量与投标人数量不一致导致 zip 静默截断。"""
    if len(BIDDER_NAMES) != len(BID_TEXTS):
        raise SystemExit(f"BIDDER_NAMES({len(BIDDER_NAMES)}) 与 tests/workflow_fakes.BID_TEXTS"
                         f"({len(BID_TEXTS)}) 数量不一致，zip 会丢投标人，请先对齐两者。")


# ---------------------------------------------------------------- 小工具
def utc_now_iso() -> str:
    """带时区的 ISO 8601（UTC），作为索引的 generated_at。"""
    return datetime.now(timezone.utc).isoformat()


class GapLog:
    """记录"真实接口拿不到"的字段，最终写入 index.json 的 gaps，绝不伪造。"""

    def __init__(self) -> None:
        self.items: list[str] = []

    def add(self, message: str) -> None:
        if message not in self.items:
            self.items.append(message)


def write_json(path: Path, payload) -> int:
    """UTF-8 写 JSON，返回**真实落盘字节数**（用于末尾清单）。

    ``newline="\\n"`` 是必要的：Windows 文本模式默认把 ``\\n`` 转成 ``\\r\\n``，
    会让文件比 ``len(text.encode())`` 大（每一行多 1 字节），导致清单里的字节数
    与磁盘实际大小不一致。这里统一写 LF，并用 ``stat().st_size`` 回报真实大小。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
    return path.stat().st_size


def api_json(client: TestClient, method: str, url: str, *, gaps: GapLog = None,
             params: dict | None = None, json_body: dict | None = None,
             headers: dict | None = None, expect: tuple[int, ...] = (200,)):
    """调用真实 HTTP 接口并返回 (status_code, payload)。

    非预期状态码不抛异常，而是返回 payload=None 并记入 gaps，便于报告真实情况。
    """
    response = client.request(method, url, params=params, json=json_body, headers=headers)
    if response.status_code not in expect:
        if gaps is not None:
            body = response.text[:300].replace("\n", " ")
            gaps.add(f"{method} {url} 返回 {response.status_code}（期望 {expect}），响应片段：{body}")
        return response.status_code, None
    try:
        return response.status_code, response.json()
    except ValueError:
        if gaps is not None:
            gaps.add(f"{method} {url} 的响应不是 JSON")
        return response.status_code, None


def require(payload, message: str):
    if payload is None:
        raise RuntimeError(message)
    return payload


def apply_review(client: TestClient, run: dict, step: str, *, key: str, decision: str = "confirm",
                 patch: dict | None = None, reason: str = "核对原文", gaps: GapLog = None) -> dict:
    """提交一次人工复核（confirm/edit），返回最新的 run 状态。"""
    body = {"decision": decision, "target_id": step, "patch": patch or {}, "reason": reason,
            "expected_version": run["revision"]}
    status, payload = api_json(client, "POST", f"/api/v1/runs/{run['run_id']}/reviews",
                               gaps=gaps, json_body=body, headers={"Idempotency-Key": key}, expect=(201,))
    if DEBUG:
        print(f"[debug] review POST key={key} step={step} decision={decision} "
              f"expected_version={body['expected_version']} -> http={status} "
              f"review_id={(payload or {}).get('review_id')} "
              f"returned_status={((payload or {}).get('run') or {}).get('status')} "
              f"returned_rev={((payload or {}).get('run') or {}).get('revision')}", flush=True)
    if payload is None:
        raise RuntimeError(f"复核失败：target={step} decision={decision} status={status}")
    return payload["run"]


def advance(client: TestClient, created: dict, runner: WorkerRunner, plan: list[dict], *,
            gaps: GapLog = None, max_rounds: int = 40) -> dict:
    """把 run 推进到 succeeded，返回最终 RunResponse（dict）。

    ``plan`` 是 (step, key, decision, patch, reason) 形式的复核计划。遇到
    ``awaiting_review`` 就消费一条；run 已 ``succeeded`` 但计划里还有 edit 复核时，
    先提交复核（后端允许对 succeeded 的 run 追加 edit）再重跑下游步骤，这样
    才会产生"旧报告 stale + 新报告"的历史版本。
    """
    run_id = created["run_id"]
    actions = list(plan)
    if DEBUG:
        print(f"[debug] advance ENTER run={run_id} plan_raw={plan!r} n={len(actions)}", flush=True)
    for _ in range(max_rounds):
        status, payload = api_json(client, "GET", f"/api/v1/runs/{run_id}", gaps=gaps)
        state = require(payload, f"读取 run {run_id} 失败")
        if DEBUG:
            print(f"[debug] advance GET run={run_id} -> status={state['status']} step={state['current_step']} "
                  f"rev={state['revision']} stale={state['result_stale']}", flush=True)
        if state["status"] == "succeeded":
            # 后端允许对已 succeeded 的 run 追加 edit 复核（review_service 允许
            # {"awaiting_review","succeeded","failed"}），所以计划里还有动作时先提交，
            # 而不是直接返回——否则"改分 → 旧报告 stale → 新报告"这条链路永远不会发生。
            if not actions:
                return state
            action = actions.pop(0)
            apply_review(client, state, action["step"], key=action["key"],
                         decision=action.get("decision", "confirm"), patch=action.get("patch"),
                         reason=action.get("reason", "核对原文"), gaps=gaps)
            continue
        if state["status"] == "failed":
            if not actions:
                return state
            raise RuntimeError(f"run {run_id} 已 failed（error={state.get('error')}）"
                               f"，仍有未消费的复核计划 {[a['step'] for a in actions]}")
        if DEBUG:
            print(f"[debug] advance run={run_id} status={state['status']} step={state['current_step']} "
                  f"rev={state['revision']} completed={state['completed_steps']} "
                  f"stale={state['result_stale']} remaining_plan={[a['step'] for a in actions]}", flush=True)
        if state["status"] == "awaiting_review":
            if not actions:
                raise RuntimeError(f"run {run_id} 停在 awaiting_review 但复核计划已用完"
                                   f"（step={state['current_step']}）")
            action = actions.pop(0)
            if action["step"] != state["current_step"]:
                gaps.add(f"复核计划步骤 {action['step']} 与真实待复核步骤 {state['current_step']} 不一致")
            apply_review(client, state, state["current_step"], key=action["key"],
                         decision=action.get("decision", "confirm"), patch=action.get("patch"),
                         reason=action.get("reason", "核对原文"), gaps=gaps)
            continue
        # status == "running"：继续执行下一步
        updated = asyncio.run(runner.run_once(run_id))
        if updated is None:
            raise RuntimeError(f"run {run_id} 无法被 worker 领取（status={state['status']}）")
    raise RuntimeError(f"run {run_id} 在 {max_rounds} 轮内未结束")


def make_runner(repo, *, workflows=None, model=None, max_attempts: int = 1) -> WorkerRunner:
    gateway = LLMGateway(model or FakeModel(), max_attempts=max_attempts, retry_seconds=0)
    if workflows is None:
        return WorkerRunner(repo, gateway)
    return WorkerRunner(repo, gateway, workflows=workflows)


# ---------------------------------------------------------------- 造数：评标链路
def build_bid_evaluation(client: TestClient, repo, gaps: GapLog) -> dict:
    """公告 + 招标文件 + 2 家投标人：一次 await_review、一次改分/重排 stale、最终最新报告。

    返回 {"project": ..., "bidders": [...], "documents": [...], "run": <最终 RunResponse>}。
    """
    _check_fake_materials()
    status, project = api_json(client, "POST", "/api/v1/projects",
                               gaps=gaps, json_body={"name": "合成示例：某市政工程施工总承包评标"},
                               expect=(201,))
    project = require(project, "创建评标项目失败")

    documents = []
    for role, text, filename in (("announcement", ANNOUNCEMENT_TEXT, "announcement.md"),
                                 ("tender", TENDER_TEXT, "tender.md")):
        response = client.post("/api/v1/documents",
                               data={"project_id": project["project_id"], "role": role},
                               files={"file": (filename, text.encode("utf-8"), "text/plain")})
        if response.status_code != 201:
            gaps.add(f"上传 {role} 文档失败：HTTP {response.status_code} {response.text[:200]}")
            raise RuntimeError(f"上传 {role} 文档失败：HTTP {response.status_code}")
        documents.append(require(response.json(), f"{role} 文档响应为空"))

    bidders = []
    for name, text in zip(BIDDER_NAMES, BID_TEXTS):
        response = client.post(f"/api/v1/projects/{project['project_id']}/bidders", json={"name": name})
        if response.status_code != 201:
            gaps.add(f"创建投标人 {name} 失败：HTTP {response.status_code} {response.text[:200]}")
            raise RuntimeError(f"创建投标人 {name} 失败：HTTP {response.status_code}")
        bidder = response.json()
        bidders.append(bidder)
        upload = client.post("/api/v1/documents",
                             data={"project_id": project["project_id"], "role": "bid", "bidder_id": bidder["bidder_id"]},
                             files={"file": (f"bid_{name}.md", text.encode("utf-8"), "text/plain")})
        if upload.status_code != 201:
            gaps.add(f"上传投标人 {name} 材料失败：HTTP {upload.status_code} {upload.text[:200]}")
            raise RuntimeError(f"上传投标人 {name} 材料失败：HTTP {upload.status_code}")
        documents.append(upload.json())

    document_ids = [d["document_id"] for d in documents]
    status, created = api_json(client, "POST", "/api/v1/runs", gaps=gaps, expect=(202,),
                               headers={"Idempotency-Key": KEY_BID_CREATE},
                               json_body={"type": "bid_evaluation", "project_id": project["project_id"],
                                          "document_ids": document_ids})
    created = require(created, "创建评标任务失败")
    run_id = created["run_id"]

    # 第一次 run_once：FakeModel(invalid_once=True) 让 extract 首次返回非法 JSON，
    # LLMGateway 重试后成功，但该步骤仍需人工确认 -> awaiting_review。
    runner = make_runner(repo, model=FakeModel(invalid_once=True), max_attempts=2)
    paused = asyncio.run(runner.run_once(run_id))
    if paused is None or paused.status != "awaiting_review":
        gaps.add(f"评标任务未按预期停在 awaiting_review（status={getattr(paused, 'status', None)}）")
    plan = [{"step": "extract", "key": KEY_BID_FIX_RULES,
             "decision": "confirm", "reason": "核对招标文件抽取的资格与评分规则"}]

    # 推进到 succeeded：extract 确认 -> assess -> report。
    final = advance(client, created, runner, plan, gaps=gaps)
    if final["status"] != "succeeded":
        gaps.add(f"评标链路未跑通，最终状态 {final['status']}")

    # 改分 / 重排：把 scores 与 qualifications 顺序整体反转，触发旧报告 stale。
    status, results = api_json(client, "GET", f"/api/v1/runs/{run_id}/results", gaps=gaps)
    results = require(results, "读取评标结果失败")
    status, reports = api_json(client, "GET", f"/api/v1/runs/{run_id}/reports", gaps=gaps)
    reports = require(reports, "读取评标报告列表失败")
    if not reports["items"]:
        gaps.add("评标链路没有生成报告，无法演示过期横幅")
        return {"project": project, "bidders": bidders, "documents": documents, "run": final,
                "reordered": False}
    original_report_id = reports["items"][0]["report_id"]
    if DEBUG:
        print(f"[debug] 准备改分：results_rev={results['revision']} stale={results['stale']} "
              f"reports={[(r['report_id'], r['revision'], r['stale']) for r in reports['items']]} "
              f"original={original_report_id}", flush=True)

    scores = list(reversed(results["data"]["scores"]))
    qualifications = list(reversed(results["data"]["qualifications"]))
    edit_plan = [{"step": "assess", "key": KEY_BID_EDIT_ASSESS, "decision": "edit",
                  "reason": "人工改分并按实际评审口径重排名次",
                  "patch": {"scores": scores, "qualifications": qualifications}}]
    edited = advance(client, created, runner, edit_plan, gaps=gaps)
    if DEBUG:
        print(f"[debug] 改分后 status={edited['status']} rev={edited['revision']} "
              f"stale={edited['result_stale']} reviews={edited['review_count']}", flush=True)
    if edited["status"] != "succeeded":
        gaps.add(f"评标改分后未跑通，最终状态 {edited['status']}")

    status, old_report = api_json(client, "GET", f"/api/v1/reports/{original_report_id}", gaps=gaps)
    if old_report is not None and not old_report["stale"]:
        gaps.add(f"改分后旧报告 {original_report_id} 未标记 stale（result_stale={edited.get('result_stale')}）")

    return {"project": project, "bidders": bidders, "documents": documents, "run": edited,
            "reordered": True, "original_report_id": original_report_id}


# ---------------------------------------------------------------- 造数：机会链路
def build_opportunity_discovery(client: TestClient, repo, settings, gaps: GapLog) -> dict:
    """画像 → 人工确认 → 公司画像落库 → 结果 → 报告。"""
    status, project = api_json(client, "POST", "/api/v1/projects",
                               gaps=gaps, json_body={"name": "合成示例：某施工企业投标机会发现"},
                               expect=(201,))
    project = require(project, "创建机会发现项目失败")

    upload = client.post("/api/v1/documents",
                         data={"project_id": project["project_id"], "role": "profile"},
                         files={"file": ("company_profile.md", PROFILE_TEXT.encode("utf-8"), "text/plain")})
    if upload.status_code != 201:
        gaps.add(f"上传企业画像失败：HTTP {upload.status_code} {upload.text[:200]}")
        raise RuntimeError(f"上传企业画像失败：HTTP {upload.status_code}")
    profile_document = upload.json()

    status, created = api_json(client, "POST", "/api/v1/runs", gaps=gaps, expect=(202,),
                               headers={"Idempotency-Key": KEY_OPP_CREATE},
                               json_body={"type": "opportunity_discovery", "project_id": project["project_id"],
                                          "document_ids": [profile_document["document_id"]]})
    created = require(created, "创建机会发现任务失败")
    run_id = created["run_id"]

    gateway = LLMGateway(FakeModel(), max_attempts=1)
    flow = OpportunityDiscoveryWorkflow(repo, gateway, searcher=FakeSearch(),
                                        crawler=FakeCrawler(settings.project_root), settings=settings)
    runner = WorkerRunner(repo, gateway, workflows={"opportunity_discovery": flow})

    paused = asyncio.run(runner.run_once(run_id))
    if paused is None or paused.status != "awaiting_review":
        gaps.add(f"机会任务未按预期停在 awaiting_review（status={getattr(paused, 'status', None)}）")
    plan = [{"step": paused.current_step if paused is not None else "profile",
             "key": KEY_OPP_CONFIRM_PROFILE, "decision": "confirm",
             "reason": "人工确认企业画像与引用证据"}]

    final = advance(client, created, runner, plan, gaps=gaps)
    if final["status"] != "succeeded":
        gaps.add(f"机会发现链路未跑通，最终状态 {final['status']}")

    status, companies = api_json(client, "GET", "/api/v1/companies", gaps=gaps)
    companies = require(companies, "读取企业画像列表失败")
    if not companies["items"]:
        gaps.add("机会链路未产生已确认的企业画像")
    return {"project": project, "documents": [profile_document], "run": final,
            "companies": companies["items"]}


# ---------------------------------------------------------------- 索引收集
def collect_run_bundle(client: TestClient, run_id: str, gaps: GapLog) -> dict:
    """按前端契约抓取单个 run 的全量数据（原样保存响应）。"""
    status, run = api_json(client, "GET", f"/api/v1/runs/{run_id}", gaps=gaps)
    run = require(run, f"读取 run {run_id} 失败")
    status, events = api_json(client, "GET", f"/api/v1/runs/{run_id}/events",
                              gaps=gaps, params={"after_seq": 0, "limit": 100})
    status, results = api_json(client, "GET", f"/api/v1/runs/{run_id}/results", gaps=gaps)
    status, reviews = api_json(client, "GET", f"/api/v1/runs/{run_id}/reviews", gaps=gaps, params={"limit": 100})
    status, reports = api_json(client, "GET", f"/api/v1/runs/{run_id}/reports", gaps=gaps, params={"limit": 100})
    items = (reports or {}).get("items", []) if reports else []
    report_details = {}
    for item in items:
        status, detail = api_json(client, "GET", f"/api/v1/reports/{item['report_id']}", gaps=gaps)
        if detail is not None:
            report_details[str(item["report_id"])] = detail
    bundle = {"run": run, "events": (events or {}).get("items", []) if events else [],
              "results": results, "reviews": (reviews or {}).get("items", []) if reviews else [],
              "reports": items, "report_details": report_details}
    if not bundle["events"]:
        gaps.add(f"run {run_id} 的 events 为空（GET /runs/{run_id}/events?after_seq=0 未返回条目）")
    if results is None:
        gaps.add(f"run {run_id} 的 results 不可用（GET /runs/{run_id}/results 非 200）")
    return bundle


def collect_document_bundle(client: TestClient, document_id: str, gaps: GapLog) -> dict:
    status, document = api_json(client, "GET", f"/api/v1/documents/{document_id}", gaps=gaps)
    document = require(document, f"读取文档 {document_id} 失败")
    status, chunks = api_json(client, "GET", f"/api/v1/documents/{document_id}/chunks",
                              gaps=gaps, params={"limit": 100})
    return {"document": document, "chunks": (chunks or {}).get("items", []) if chunks else []}


def find_evidence_refs(value, bucket: list) -> list:
    """遍历结果，收集所有证据引用（document_id/chunk_id/quote/document_hash）。"""
    if isinstance(value, dict):
        if {"document_id", "chunk_id", "quote", "document_hash"} <= set(value):
            if value not in bucket:
                bucket.append(value)
        for child in value.values():
            find_evidence_refs(child, bucket)
    elif isinstance(value, list):
        for child in value:
            find_evidence_refs(child, bucket)
    return bucket


# ---------------------------------------------------------------- 主流程
def export() -> dict:
    if not OUTPUT_DIR.parent.exists():
        OUTPUT_DIR.parent.mkdir(parents=True, exist_ok=True)
    # 幂等重跑：先整体清空目标目录
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)
    EPHEMERAL_DIR.mkdir(parents=True, exist_ok=True)

    gaps = GapLog()
    settings = Settings(project_root=EPHEMERAL_DIR, api_key="", base_url="https://example.invalid/v1",
                        doc_model="fake", agent_model="fake", retry_count=1, retry_seconds=0,
                        database_url=f"sqlite:///{DB_FILE.as_posix()}")

    bundles: dict[str, dict] = {}
    index = {
        "generated_at": utc_now_iso(),
        "source": SOURCE_NOTE,
        "notice": NOTICE,
        "projects": [],
        "bidders": [],
        "documents": [],
        "runs": [],
        "reports": [],
        "companies": [],
    }
    written: list[tuple[str, int]] = []

    with TestClient(create_app(settings)) as client:
        repo = client.app.state.repository

        bid = build_bid_evaluation(client, repo, gaps)
        opp = build_opportunity_discovery(client, repo, settings, gaps)

        index["projects"] = [bid["project"], opp["project"]]
        index["bidders"] = [dict(bidder) for bidder in bid["bidders"]]

        document_ids: list[str] = [d["document_id"] for d in bid["documents"]] + \
                                  [d["document_id"] for d in opp["documents"]]
        for document_id in document_ids:
            bundle = collect_document_bundle(client, document_id, gaps)
            document = bundle["document"]
            written.append((f"documents/{document_id}.json",
                            write_json(OUTPUT_DIR / "documents" / f"{document_id}.json", bundle)))
            index["documents"].append({
                "document_id": document["document_id"],
                "project_id": document["project_id"],
                "bidder_id": document.get("bidder_id"),
                "role": document["role"],
                "status": document["status"],
                "format": document["format"],
                "parser": document["parser"],
                "chunk_count": document["chunk_count"],
                "diagnostics": document.get("diagnostics", []),
            })
            if document["status"] != "ready":
                gaps.add(f"文档 {document['document_id']}（role={document['role']}）状态为 {document['status']}，非 ready")
            if document.get("diagnostics"):
                gaps.add(f"文档 {document['document_id']} 带诊断信息：{document['diagnostics']}")

        for run in (bid["run"], opp["run"]):
            run_id = run["run_id"]
            bundle = collect_run_bundle(client, run_id, gaps)
            written.append((f"runs/{run_id}.json", write_json(OUTPUT_DIR / "runs" / f"{run_id}.json", bundle)))
            bundles[run_id] = bundle
            reports = bundle["reports"]
            latest_report = reports[-1] if reports else None
            index["runs"].append({
                "run_id": run["run_id"],
                "type": run["type"],
                "project_id": run["project_id"],
                "status": run["status"],
                "current_step": run["current_step"],
                "completed_steps": run["completed_steps"],
                "known_steps": run["known_steps"],
                "review_count": run["review_count"],
                "revision": run["revision"],
                "result_stale": run["result_stale"],
                "created_at": run["created_at"],
                "updated_at": run["updated_at"],
                "report_id": str(latest_report["report_id"]) if latest_report else None,
            })
            if run["status"] != "succeeded":
                gaps.add(f"run {run_id}（{run['type']}）最终状态为 {run['status']}，未到 succeeded")
            if not reports:
                gaps.add(f"run {run_id} 没有报告，前端报告页将无数据")
            for item in reports:
                index["reports"].append({"report_id": str(item["report_id"]), "run_id": item["run_id"],
                                         "revision": item["revision"], "stale": item["stale"],
                                         "confirmed": item["confirmed"]})
            if len(reports) < 2 and run is bid["run"]:
                gaps.add(f"评标 run {run_id} 只有 {len(reports)} 份报告，缺少历史 stale 版本")
            if not any(item["stale"] for item in reports) and run is bid["run"]:
                gaps.add(f"评标 run {run_id} 没有 stale 报告，前端过期横幅将无数据")

        status, companies = api_json(client, "GET", "/api/v1/companies", gaps=gaps, params={"limit": 100})
        for item in (companies or {}).get("items", []):
            index["companies"].append({"company_id": item["company_id"], "name": item.get("name"),
                                       "revision": item.get("revision"), "confirmed": item.get("confirmed", False)})

        # 多跑一次列表接口分页形态，确保 index 与真实接口口径一致（不写文件，仅校验）
        status, run_page = api_json(client, "GET", "/api/v1/runs", gaps=gaps,
                                    params={"project_id": index["projects"][0]["project_id"], "limit": 20})
        if run_page is None or "next_cursor" not in run_page:
            gaps.add("GET /api/v1/runs 未返回 {items, next_cursor} 形态的分页响应")

        status, project_page = api_json(client, "GET", "/api/v1/projects", gaps=gaps, params={"limit": 20})
        if project_page is None or "next_cursor" not in project_page:
            gaps.add("GET /api/v1/projects 未返回 {items, next_cursor} 形态的分页响应")

    # 证据矩阵统计（用于报告与 index 摘要）
    evidence_total = 0
    for bundle in bundles.values():
        if bundle["results"]:
            evidence_total += len(bundle["results"].get("evidence_matrix", []))

    index["gaps"] = gaps.items
    index["statistics"] = {
        "projects": len(index["projects"]),
        "bidders": len(index["bidders"]),
        "documents": len(index["documents"]),
        "runs": len(index["runs"]),
        "reports": len(index["reports"]),
        "companies": len(index["companies"]),
        "evidence_matrix_refs": evidence_total,
        "generated_by": SOURCE_NOTE,
        "offline": True,
    }
    written.append(("index.json", write_json(OUTPUT_DIR / "index.json", index)))
    written.append(("README.md", write_readme(OUTPUT_DIR)))

    return {"index": index, "files": sorted(written), "evidence_total": evidence_total,
            "run_files": sorted(bundles), "gaps": gaps.items}


README_TEXT = """# 前端离线演示夹具（fixtures）

## 这是谁生成的
本目录全部内容由脚本 `scripts/export_frontend_fixtures.py` 生成，命令：

```powershell
.venv311\\Scripts\\python.exe scripts/export_frontend_fixtures.py
```

脚本通过 `TestClient` 调用**真实后端 HTTP 接口**造数，模型与搜索使用
`tests/workflow_fakes.py` 中的离线 fake 实现，**全程无网络、无 API Key**。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `index.json` | 总索引：`projects` / `bidders` / `documents` / `runs` / `reports` / `companies`，另有 `gaps` 与 `statistics` |
| `runs/<run_id>.json` | 单个任务的全量数据：`run`、`events`、`results`、`reviews`、`reports`、`report_details` |
| `documents/<document_id>.json` | 单个材料：`document`（GET 响应原样）与 `chunks` 列表 |

所有响应均为**后端原样 JSON**：字段不裁剪、不归一化，数值保持十进制字符串
（如 `"8.5"`、`"6.25"`、`"86.75"`），时间为带时区 ISO 8601。

## 哪些是合成数据
**全部都是合成数据。** 项目名、投标人、材料正文、公告与企业画像均为演示用假数据，
由 `tests/workflow_fakes.py` 的常量文本生成；其中的评分、结论、证据引用都是
离线 fake 模型的固定输出，不对应任何真实招标项目或真实企业。

演示覆盖的真实状态：

1. `bid_evaluation`：公告 + 招标文件 + 2 家投标人（`tests/workflow_fakes.BID_TEXTS`
   只提供 2 份合成投标材料，脚本按数量对齐投标人，`BID0` 得 `"8.5"`、`BID1` 得 `"6.25"`），
   包含一次 `awaiting_review` 复核（抽取规则首次返回非法 JSON，重试后仍需人工确认）、
   一次"改分 / 重排"编辑复核，因此保留 **一个历史 stale 报告 + 一个最新报告**。
2. `opportunity_discovery`：企业画像 → 人工确认 → 公司画像落库 → 检索 → 结果 → 报告。

## `gaps` 的含义
`index.json` 的 `gaps` 是数组，记录**脚本无法从真实接口取得或未达预期的字段/状态**
（例如 events 为空、某文档状态不是 `ready`、某条链路未跑到 `succeeded`）。
出现 `gaps` 条目不表示夹具被伪造——脚本只做如实记录，**不会补假数据**。
若 `gaps` 非空，请把该条目当作已知限制读，而不是当作可展示的真实数据。

## 使用红线
**不得把本目录的合成示例当作真实材料验收结论。** 这些夹具仅用于前端离线演示、
组件联调与截图验收；任何面向真实招投标材料的验收、评分、结论都必须来自
真实后端对真实（脱敏）材料的处理结果。

## 幂等与重跑
脚本每次运行会先清空本目录再重建；`Idempotency-Key` 使用固定字符串，
除 `generated_at` 与随机生成的 id 外产物内容稳定。重跑不会触碰
`data/backend.db` 或仓库中其它已有数据库。
"""


def write_readme(destination: Path) -> int:
    path = destination / "README.md"
    path.write_text(README_TEXT, encoding="utf-8", newline="\n")
    return path.stat().st_size


def main() -> int:
    result = export()
    index = result["index"]
    print("=== 前端离线夹具导出完成 ===")
    print(f"输出目录：{OUTPUT_DIR}")
    print(f"generated_at：{index['generated_at']}")
    print("统计：projects={projects} bidders={bidders} documents={documents} runs={runs} "
          "reports={reports} companies={companies} evidence_matrix_refs={evidence_matrix_refs}".format(
              **index["statistics"]))
    print("产物清单（相对路径 / 字节数）：")
    for relative, size in result["files"]:
        print(f"  {relative}  {size} bytes")
    if result["gaps"]:
        print(f"gaps（{len(result['gaps'])} 条，已写入 index.json，未伪造数据）：")
        for item in result["gaps"]:
            print(f"  - {item}")
    else:
        print("gaps：无（所有预期状态均从真实接口取得）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
