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


@lru_cache
def get_settings() -> Settings:
    return Settings()
