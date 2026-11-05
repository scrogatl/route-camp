"""Engine and session wiring. Swap DATABASE_URL to move from SQLite to Postgres."""

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base

SessionLocal = sessionmaker(autoflush=False, expire_on_commit=False)

_IN_MEMORY_SQLITE = ("sqlite://", "sqlite:///:memory:")


def make_engine(url: str) -> Engine:
    if not url.startswith("sqlite"):
        return create_engine(url)

    kwargs: dict = {"connect_args": {"check_same_thread": False}}
    if url in _IN_MEMORY_SQLITE:
        kwargs["poolclass"] = StaticPool
    else:
        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, **kwargs)

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _record):  # SQLite ignores FKs unless asked
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def configure(url: str) -> Engine:
    engine = make_engine(url)
    Base.metadata.create_all(engine)
    SessionLocal.configure(bind=engine)
    return engine


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
