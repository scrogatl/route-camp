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
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 575b4b0 | Add data model, settings and database wiring
# END LICENSE HEADER
"""Runtime settings. Every value can be overridden with a ROUTE_CAMP_ environment variable."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ROUTE_CAMP_", env_file=".env", extra="ignore")

    # SQLite by default. Swap for e.g. postgresql+psycopg://... later; nothing else needs to change.
    database_url: str = "sqlite:///./data/route_camp.db"
    # GraphHopper's HTTP API (the routing container in docker-compose).
    graphhopper_url: str = "http://localhost:8989"
    # Served to the frontend through /api/config.
    map_style_url: str = "https://tiles.openfreemap.org/styles/liberty"
    cors_origins: list[str] = ["http://localhost:5173"]
    # Garmin export: a shaping point roughly every this many km along the calculated line (0 turns them off),
    # and the most route points (stops + shaping points) one exported route may have.
    shaping_spacing_km: float = 10.0
    max_route_points: int = 50


@lru_cache
def get_settings() -> Settings:
    return Settings()
