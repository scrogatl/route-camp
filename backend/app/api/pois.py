from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_or_404
from app.database import get_session
from app.models import POI, Tag
from app.schemas import POIIn, POIOut, POIUpdate, poi_out
from app.services import get_or_create_tags

router = APIRouter(prefix="/pois", tags=["pois"])


@router.get("", response_model=list[POIOut])
def list_pois(tag: str | None = None, session: Session = Depends(get_session)):
    stmt = select(POI).order_by(POI.name, POI.id)
    if tag:
        stmt = stmt.where(POI.tags.any(Tag.name == tag.strip().lower()))
    return [poi_out(poi) for poi in session.scalars(stmt)]


@router.post("", response_model=POIOut, status_code=201)
def create_poi(payload: POIIn, session: Session = Depends(get_session)):
    poi = POI(
        name=payload.name,
        lat=payload.lat,
        lon=payload.lon,
        notes=payload.notes,
        score=payload.score,
        state=payload.state,
        tags=get_or_create_tags(session, payload.tags),
    )
    session.add(poi)
    session.commit()
    return poi_out(poi)


@router.get("/{poi_id}", response_model=POIOut)
def get_poi(poi_id: int, session: Session = Depends(get_session)):
    return poi_out(get_or_404(session, POI, poi_id))


@router.patch("/{poi_id}", response_model=POIOut)
def update_poi(poi_id: int, payload: POIUpdate, session: Session = Depends(get_session)):
    poi = get_or_404(session, POI, poi_id)
    data = payload.model_dump(exclude_unset=True)
    tags = data.pop("tags", None)
    for field, value in data.items():
        setattr(poi, field, value)
    if tags is not None:
        poi.tags = get_or_create_tags(session, tags)
    session.commit()
    return poi_out(poi)


@router.delete("/{poi_id}", status_code=204)
def delete_poi(poi_id: int, session: Session = Depends(get_session)):
    session.delete(get_or_404(session, POI, poi_id))
    session.commit()
    return Response(status_code=204)
