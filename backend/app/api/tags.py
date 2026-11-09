# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 42f2690 | Add REST API, GraphHopper routing and stop optimization
# END LICENSE HEADER
"""Tags are the "folders". Any POI, route or plan can carry any number of them."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import ITEM_MODELS, get_or_404
from app.database import get_session
from app.models import POI, Plan, Route, Tag
from app.schemas import ItemRef, TagIn, TagOut, TaggedItemsOut, plan_out, poi_out, route_out
from app.services import get_or_create_tags, normalise_tag_names

router = APIRouter(prefix="/tags", tags=["tags"])


def _tag_out(tag: Tag) -> TagOut:
    return TagOut(id=tag.id, name=tag.name)


@router.get("", response_model=list[TagOut])
def list_tags(session: Session = Depends(get_session)):
    return [_tag_out(tag) for tag in session.scalars(select(Tag).order_by(Tag.name))]


@router.post("", response_model=TagOut)
def create_tag(payload: TagIn, session: Session = Depends(get_session)):
    """Idempotent: returns the existing tag if the name is already used."""
    if not normalise_tag_names([payload.name]):
        raise HTTPException(status_code=422, detail="Tag name must not be blank")
    tag = get_or_create_tags(session, [payload.name])[0]
    session.commit()
    return _tag_out(tag)


@router.delete("/{tag_id}", status_code=204)
def delete_tag(tag_id: int, session: Session = Depends(get_session)):
    session.delete(get_or_404(session, Tag, tag_id))
    session.commit()
    return Response(status_code=204)


@router.get("/{tag_id}/items", response_model=TaggedItemsOut)
def list_tagged_items(tag_id: int, session: Session = Depends(get_session)):
    get_or_404(session, Tag, tag_id)
    pois = session.scalars(select(POI).where(POI.tags.any(Tag.id == tag_id)).order_by(POI.name))
    routes = session.scalars(select(Route).where(Route.tags.any(Tag.id == tag_id)).order_by(Route.name))
    plans = session.scalars(select(Plan).where(Plan.tags.any(Tag.id == tag_id)).order_by(Plan.name))
    return TaggedItemsOut(
        pois=[poi_out(p) for p in pois],
        routes=[route_out(r) for r in routes],
        plans=[plan_out(p) for p in plans],
    )


@router.post("/{tag_id}/items", status_code=204)
def tag_item(tag_id: int, ref: ItemRef, session: Session = Depends(get_session)):
    tag = get_or_404(session, Tag, tag_id)
    item = get_or_404(session, ITEM_MODELS[ref.kind], ref.id)
    if tag not in item.tags:
        item.tags.append(tag)
    session.commit()
    return Response(status_code=204)


@router.delete("/{tag_id}/items/{kind}/{item_id}", status_code=204)
def untag_item(tag_id: int, kind: Literal["poi", "route", "plan"], item_id: int, session: Session = Depends(get_session)):
    tag = get_or_404(session, Tag, tag_id)
    item = get_or_404(session, ITEM_MODELS[kind], item_id)
    if tag in item.tags:
        item.tags.remove(tag)
    session.commit()
    return Response(status_code=204)
