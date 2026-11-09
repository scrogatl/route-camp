# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 15:57:09 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 5f93c30 | Export Garmin shaping points along the route line
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 42f2690 | Add REST API, GraphHopper routing and stop optimization
# END LICENSE HEADER
from typing import TypeVar

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from app.config import Settings
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


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings
