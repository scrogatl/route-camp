"""Business logic shared by the API routers and the GPX code."""

from dataclasses import dataclass
from typing import TypeVar

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.gpx import GpxPoint, ParsedGpx, build_route_gpx
from app.models import POI, Base, Plan, PlanRoute, Route, RouteStop, Tag

COORD_TOLERANCE = 1e-6  # ~10 cm; used to match GPX points to existing POIs

M = TypeVar("M", bound=Base)


@dataclass
class ImportSummary:
    pois_created: int = 0
    pois_matched: int = 0
    routes_created: int = 0
    tracks_skipped: int = 0


def normalise_tag_names(names: list[str]) -> list[str]:
    return sorted({name.strip().lower() for name in names if name.strip()})


def get_or_create_tags(session: Session, names: list[str]) -> list[Tag]:
    tags = []
    for name in normalise_tag_names(names):
        tag = session.scalar(select(Tag).where(Tag.name == name))
        if tag is None:
            tag = Tag(name=name)
            session.add(tag)
            session.flush()
        tags.append(tag)
    return tags


def _load_by_ids(session: Session, model: type[M], ids: list[int]) -> dict[int, M]:
    if not ids:
        return {}
    found = {obj.id: obj for obj in session.scalars(select(model).where(model.id.in_(set(ids))))}
    missing = sorted(set(ids) - found.keys())
    if missing:
        raise ValueError(f"Unknown {model.__name__} ids: {missing}")
    return found


def set_route_stops(session: Session, route: Route, poi_ids: list[int]) -> None:
    """Replace a route's ordered POI references. Duplicates are allowed (a route may pass a POI twice)."""
    pois = _load_by_ids(session, POI, poi_ids)
    route.stops = [RouteStop(poi=pois[poi_id], position=i) for i, poi_id in enumerate(poi_ids)]
    route.invalidate()


def set_plan_routes(session: Session, plan: Plan, route_ids: list[int]) -> None:
    routes = _load_by_ids(session, Route, route_ids)
    plan.route_links = [PlanRoute(route=routes[rid], position=i) for i, rid in enumerate(route_ids)]


def find_or_create_poi(session: Session, name: str, lat: float, lon: float, notes: str | None) -> tuple[POI, bool]:
    for poi in session.scalars(select(POI).where(POI.name == name)):
        if abs(poi.lat - lat) < COORD_TOLERANCE and abs(poi.lon - lon) < COORD_TOLERANCE:
            return poi, False
    poi = POI(name=name, lat=lat, lon=lon, notes=notes)
    session.add(poi)
    session.flush()
    return poi, True


def _coord_key(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, 6), round(lon, 6)


def import_gpx(session: Session, parsed: ParsedGpx) -> ImportSummary:
    """Waypoints become POIs (reused when name and position match); rte entries become routes of those POIs.

    Tracks (trk) are not imported yet; they are counted in the summary. TODO: import as route geometry.
    """
    summary = ImportSummary(tracks_skipped=len(parsed.tracks))
    by_coord: dict[tuple[float, float], POI] = {}

    def resolve(point: GpxPoint) -> POI:
        key = _coord_key(point.lat, point.lon)
        if key not in by_coord:
            poi, created = find_or_create_poi(session, point.name or "Unnamed POI", point.lat, point.lon, point.desc)
            summary.pois_created += created
            summary.pois_matched += not created
            by_coord[key] = poi
        return by_coord[key]

    for waypoint in parsed.waypoints:
        resolve(waypoint)

    for index, gpx_route in enumerate(parsed.routes, start=1):
        route = Route(name=gpx_route.name or f"Imported route {index}", profile="car")
        route.stops = [RouteStop(poi=resolve(point), position=i) for i, point in enumerate(gpx_route.points)]
        session.add(route)
        summary.routes_created += 1

    session.flush()
    return summary


def _gpx_point(poi: POI) -> GpxPoint:
    return GpxPoint(name=poi.name, lat=poi.lat, lon=poi.lon, desc=poi.notes)


def export_route_gpx(route: Route) -> str:
    stops = [stop.poi for stop in route.stops]
    unique_pois = {poi.id: poi for poi in stops}
    geometry = [(lat, lon) for lon, lat in route.geometry] if route.geometry else None
    return build_route_gpx(
        route_name=route.name,
        waypoints=[_gpx_point(poi) for poi in unique_pois.values()],
        route_points=[_gpx_point(poi) for poi in stops],
        geometry=geometry,
    )
