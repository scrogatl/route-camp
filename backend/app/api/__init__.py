from fastapi import APIRouter

from app.api import gpx_files, plans, pois, routes, tags

api_router = APIRouter()
for module in (pois, routes, plans, tags, gpx_files):
    api_router.include_router(module.router)
