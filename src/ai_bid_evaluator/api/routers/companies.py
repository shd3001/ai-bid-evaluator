from fastapi import APIRouter, Depends
from ai_bid_evaluator.api.schemas import CompanyProfile, Page
from ai_bid_evaluator.api.dependencies import get_query_service
from ai_bid_evaluator.domain.base import Identifier
from .common import Limit, Cursor

router = APIRouter(tags=["companies"])


@router.get("/companies", response_model=Page[CompanyProfile], operation_id="companies_list")
def companies(limit: Limit = 20, cursor: Cursor = None, service=Depends(get_query_service)):
    return service.companies(limit, cursor)


@router.get("/companies/{company_id}", response_model=CompanyProfile, operation_id="companies_get")
def company(company_id: Identifier, service=Depends(get_query_service)):
    return service.company(company_id)
