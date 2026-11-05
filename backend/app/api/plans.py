from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_or_404
from app.database import get_session
from app.models import Plan, Tag
from app.schemas import PlanIn, PlanOut, PlanUpdate, plan_out
from app.services import get_or_create_tags, set_plan_routes

router = APIRouter(prefix="/plans", tags=["plans"])


@router.get("", response_model=list[PlanOut])
def list_plans(tag: str | None = None, session: Session = Depends(get_session)):
    stmt = select(Plan).order_by(Plan.name, Plan.id)
    if tag:
        stmt = stmt.where(Plan.tags.any(Tag.name == tag.strip().lower()))
    return [plan_out(plan) for plan in session.scalars(stmt)]


@router.post("", response_model=PlanOut, status_code=201)
def create_plan(payload: PlanIn, session: Session = Depends(get_session)):
    plan = Plan(name=payload.name, notes=payload.notes)
    session.add(plan)
    try:
        set_plan_routes(session, plan, payload.route_ids)
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    plan.tags = get_or_create_tags(session, payload.tags)
    session.commit()
    return plan_out(plan)


@router.get("/{plan_id}", response_model=PlanOut)
def get_plan(plan_id: int, session: Session = Depends(get_session)):
    return plan_out(get_or_404(session, Plan, plan_id))


@router.patch("/{plan_id}", response_model=PlanOut)
def update_plan(plan_id: int, payload: PlanUpdate, session: Session = Depends(get_session)):
    plan = get_or_404(session, Plan, plan_id)
    data = payload.model_dump(exclude_unset=True)
    tags = data.pop("tags", None)
    route_ids = data.pop("route_ids", None)
    for field, value in data.items():
        setattr(plan, field, value)
    if route_ids is not None:
        try:
            set_plan_routes(session, plan, route_ids)
        except ValueError as exc:
            session.rollback()
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if tags is not None:
        plan.tags = get_or_create_tags(session, tags)
    session.commit()
    return plan_out(plan)


@router.delete("/{plan_id}", status_code=204)
def delete_plan(plan_id: int, session: Session = Depends(get_session)):
    session.delete(get_or_404(session, Plan, plan_id))
    session.commit()
    return Response(status_code=204)
