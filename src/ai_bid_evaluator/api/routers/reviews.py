from fastapi import APIRouter, Depends
from ai_bid_evaluator.api.schemas import ReviewDecision, ReviewResponse, ReviewItem, Page
from ai_bid_evaluator.api.dependencies import get_review_service, get_query_service
from ai_bid_evaluator.domain.base import Identifier
from .common import Limit, Cursor, idempotency_key

router = APIRouter(tags=["reviews"])


@router.get("/runs/{run_id}/reviews", response_model=Page[ReviewItem], operation_id="reviews_list")
def reviews(run_id: Identifier, limit: Limit = 20, cursor: Cursor = None, service=Depends(get_query_service)):
    return service.reviews(run_id, limit, cursor)


@router.post("/runs/{run_id}/reviews", status_code=201, response_model=ReviewResponse, operation_id="reviews_apply")
def apply_review(run_id: Identifier, request: ReviewDecision, key=Depends(idempotency_key), service=Depends(get_review_service),
                 query=Depends(get_query_service)):
    state = service.apply(run_id, request, key)
    return query.review_response(run_id, state)
