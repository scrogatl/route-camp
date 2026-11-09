# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-06 06:20:07 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 108a72d | Add time at each stop: a default for all stops and a bonus's own minutes
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 42f2690 | Add REST API, GraphHopper routing and stop optimization
# END LICENSE HEADER
from fastapi import APIRouter

from app.api import gpx_files, plans, pois, routes, settings, tags

api_router = APIRouter()
for module in (pois, routes, plans, tags, gpx_files, settings):
    api_router.include_router(module.router)
