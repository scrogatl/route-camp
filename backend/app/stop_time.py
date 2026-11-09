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
# END LICENSE HEADER
"""Time spent at a route's stops, on top of the driving time.

Every stop takes the default minutes (AppSetting "stop_minutes", 5 unless changed), or its POI's own
stop_minutes when set. The first and last stops are where the ride starts and ends (Rally HQ), so they
count only when their POI has its own minutes, as rally-route-finder counts them.
"""

from sqlalchemy.orm import Session

from app.models import POI, AppSetting

DEFAULT_STOP_MINUTES = 5.0


def default_stop_minutes(session: Session) -> float:
    setting = session.get(AppSetting, "stop_minutes")
    return DEFAULT_STOP_MINUTES if setting is None or setting.value is None else setting.value


def set_default_stop_minutes(session: Session, minutes: float) -> None:
    setting = session.get(AppSetting, "stop_minutes")
    if setting is None:
        session.add(AppSetting(key="stop_minutes", value=minutes))
    else:
        setting.value = minutes


def stop_minutes(poi: POI, default_minutes: float, at_end: bool) -> float:
    if poi.stop_minutes is not None:
        return poi.stop_minutes
    return 0.0 if at_end else default_minutes


def stop_seconds(pois: list[POI], default_minutes: float) -> float:
    last = len(pois) - 1
    return 60 * sum(stop_minutes(poi, default_minutes, n in (0, last)) for n, poi in enumerate(pois))
