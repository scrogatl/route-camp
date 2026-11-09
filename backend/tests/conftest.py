# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 575b4b0 | Add data model, settings and database wiring
# END LICENSE HEADER
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.config import Settings
from app.database import make_engine
from app.main import create_app
from app.models import Base


@pytest.fixture
def db_session():
    engine = make_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


@pytest.fixture
def client():
    # GraphHopper points at a closed port, so routing endpoints exercise their error path without a real server.
    settings = Settings(database_url="sqlite://", graphhopper_url="http://127.0.0.1:1", cors_origins=[])
    with TestClient(create_app(settings)) as test_client:
        yield test_client
