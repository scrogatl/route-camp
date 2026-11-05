from typing import TypeVar

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app.models import Base, POI, Plan, Route
from app.routing import GraphHopperClient

M = TypeVar("M", bound=Base)

ITEM_MODELS: dict[str, type[POI] | type[Route] | type[Plan]] = {"poi": POI, "route": Route, "plan": Plan}


def get_or_404(session: Session, model: type[M], item_id: int) -> M:
    obj = session.get(model, item_id)
    if obj is None:
        raise HTTPException(status_code=404, detail=f"{model.__name__} {item_id} not found")
    return obj


def get_graphhopper(request: Request) -> GraphHopperClient:
    return request.app.state.graphhopper
