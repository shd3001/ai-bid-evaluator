from fastapi import APIRouter, Depends
from ai_bid_evaluator.api.schemas import ProjectCreate, ProjectResponse, BidderCreate, BidderResponse, Page
from ai_bid_evaluator.api.dependencies import get_query_service
from ai_bid_evaluator.domain.base import Identifier
from .common import Limit, Cursor

router = APIRouter(tags=["projects"])


@router.post("/projects", status_code=201, response_model=ProjectResponse, operation_id="projects_create")
def create_project(request: ProjectCreate, service=Depends(get_query_service)):
    return service.create_project(request)


@router.get("/projects", response_model=Page[ProjectResponse], operation_id="projects_list")
def projects(limit: Limit = 20, cursor: Cursor = None, service=Depends(get_query_service)):
    return service.projects(limit, cursor)


@router.post("/projects/{project_id}/bidders", status_code=201, response_model=BidderResponse, operation_id="bidders_create")
def create_bidder(project_id: Identifier, request: BidderCreate, service=Depends(get_query_service)):
    return service.create_bidder(project_id, request)
