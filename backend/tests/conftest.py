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
