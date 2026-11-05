from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import database
from app.api import api_router
from app.config import Settings, get_settings
from app.routing import GraphHopperClient


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        database.configure(settings.database_url)
        yield
        app.state.graphhopper.close()

    app = FastAPI(title="route-camp", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.graphhopper = GraphHopperClient(settings.graphhopper_url)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router, prefix="/api")

    @app.get("/api/config", tags=["config"])
    def client_config() -> dict:
        return {"map_style_url": settings.map_style_url, "routing_profiles": ["car", "fun"]}

    return app


app = create_app()
