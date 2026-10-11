from typing import Annotated
from fastapi import APIRouter, Depends, Response, Query
from ai_bid_evaluator.api.schemas import RunCreate, RunResponse, VersionRequest, Page, EventResponse, EvaluationResponse
from ai_bid_evaluator.api.dependencies import get_run_service, get_query_service, get_repository
from ai_bid_evaluator.domain.base import Identifier
from ai_bid_evaluator.domain.run import RunType, RunStatus
from .common import Limit, Cursor, idempotency_key

router = APIRouter(tags=["runs"])


@router.post("/runs", status_code=202, response_model=RunResponse, operation_id="runs_create")
def create_run(request: RunCreate, response: Response, key=Depends(idempotency_key), service=Depends(get_run_service)):
    run = service.create(request, key)
    response.headers["Location"] = f"/api/v1/runs/{run.run_id}"
    return run


@router.get("/runs", response_model=Page[RunResponse], operation_id="runs_list")
def runs(limit: Limit = 20, cursor: Cursor = None, project_id: Identifier | None = None,
         type: RunType | None = None, status: RunStatus | None = None, service=Depends(get_query_service)):
    return service.runs(limit, cursor, project_id, type, status)


@router.get("/runs/{run_id}", response_model=RunResponse, operation_id="runs_get")
def run(run_id: Identifier, repository=Depends(get_repository)):
    return repository.load(run_id)


@router.get("/runs/{run_id}/events", response_model=Page[EventResponse], operation_id="runs_events")
def events(run_id: Identifier, after_seq: Annotated[int, Query(ge=0)] = 0, limit: Limit = 20, cursor: Cursor = None,
           service=Depends(get_query_service)):
    return service.events(run_id, after_seq, limit, cursor)


@router.post("/runs/{run_id}/retry", status_code=202, response_model=RunResponse, operation_id="runs_retry")
def retry(run_id: Identifier, request: VersionRequest, key=Depends(idempotency_key), service=Depends(get_run_service)):
    return service.retry(run_id, request.expected_version, key)


@router.post("/runs/{run_id}/cancel", status_code=202, response_model=RunResponse, responses={200: {"model": RunResponse}}, operation_id="runs_cancel")
def cancel(run_id: Identifier, request: VersionRequest, response: Response, key=Depends(idempotency_key), service=Depends(get_run_service)):
    # Status selection follows the saved request version, including replays.
    state = service.cancel(run_id, request.expected_version, key)
    if not state.cancel_requested and state.status in {"succeeded", "failed", "cancelled"}:
        response.status_code = 200
    return state


@router.get("/runs/{run_id}/results", response_model=EvaluationResponse, operation_id="runs_results")
def results(run_id: Identifier, service=Depends(get_query_service)):
    return service.results(run_id)
