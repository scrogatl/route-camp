from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_graphhopper, get_or_404
from app.database import get_session
from app.models import Route, RouteStop, Tag, utcnow
from app.optimize import best_order, haversine_time_matrix
from app.routing import GraphHopperClient, RoutingError
from app.schemas import OptimizeOut, OptimizePreviewOut, OrderSummary, RouteIn, RouteOut, RouteUpdate, route_out
from app.services import get_or_create_tags, set_route_stops

router = APIRouter(prefix="/routes", tags=["routes"])


@router.get("", response_model=list[RouteOut])
def list_routes(tag: str | None = None, session: Session = Depends(get_session)):
    stmt = select(Route).order_by(Route.name, Route.id)
    if tag:
        stmt = stmt.where(Route.tags.any(Tag.name == tag.strip().lower()))
    return [route_out(route) for route in session.scalars(stmt)]


@router.post("", response_model=RouteOut, status_code=201)
def create_route(payload: RouteIn, session: Session = Depends(get_session)):
    route = Route(name=payload.name, notes=payload.notes, profile=payload.profile)
    session.add(route)
    try:
        set_route_stops(session, route, payload.poi_ids)
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    route.tags = get_or_create_tags(session, payload.tags)
    session.commit()
    return route_out(route)


@router.get("/{route_id}", response_model=RouteOut)
def get_route(route_id: int, session: Session = Depends(get_session)):
    return route_out(get_or_404(session, Route, route_id))


@router.patch("/{route_id}", response_model=RouteOut)
def update_route(route_id: int, payload: RouteUpdate, session: Session = Depends(get_session)):
    route = get_or_404(session, Route, route_id)
    data = payload.model_dump(exclude_unset=True)
    tags = data.pop("tags", None)
    poi_ids = data.pop("poi_ids", None)
    changed_line = bool(data.keys() & {"profile"})
    for field, value in data.items():
        setattr(route, field, value)
    if poi_ids is not None:
        try:
            set_route_stops(session, route, poi_ids)
        except ValueError as exc:
            session.rollback()
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    elif changed_line:
        route.invalidate()
    if tags is not None:
        route.tags = get_or_create_tags(session, tags)
    session.commit()
    return route_out(route)


@router.delete("/{route_id}", status_code=204)
def delete_route(route_id: int, session: Session = Depends(get_session)):
    session.delete(get_or_404(session, Route, route_id))
    session.commit()
    return Response(status_code=204)


def _refuse_if_imported(route: Route, replace_imported: bool) -> None:
    """An imported GPX track is only replaced when the caller asks for it explicitly."""
    if route.geometry_source == "imported" and not replace_imported:
        raise HTTPException(
            status_code=409,
            detail="This route has an imported GPX track. Pass replace_imported=true to replace it.",
        )


@router.post("/{route_id}/calculate", response_model=RouteOut)
def calculate_route(
    route_id: int,
    replace_imported: bool = False,
    session: Session = Depends(get_session),
    graphhopper: GraphHopperClient = Depends(get_graphhopper),
):
    """Ask GraphHopper for the line through the route's POIs (in order) and cache geometry, distance and time."""
    route = get_or_404(session, Route, route_id)
    _refuse_if_imported(route, replace_imported)
    points = [[stop.poi.lon, stop.poi.lat] for stop in route.stops]
    if len(points) < 2:
        raise HTTPException(status_code=422, detail="A route needs at least two POIs to calculate")
    try:
        result = graphhopper.route(points, route.profile)
    except RoutingError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    route.geometry = result.geometry
    route.geometry_source = "calculated"
    route.distance_m = result.distance_m
    route.time_s = result.time_s
    route.calculated_at = utcnow()
    session.commit()
    return route_out(route)


def _stop_matrix(graphhopper: GraphHopperClient, stops: list[RouteStop], profile: str) -> tuple[list, str]:
    """Travel times between the stops: GraphHopper's when reachable, straight-line estimates otherwise."""
    points = [[stop.poi.lon, stop.poi.lat] for stop in stops]
    try:
        return graphhopper.matrix(points, profile), "graphhopper"
    except RoutingError:
        return haversine_time_matrix([(stop.poi.lat, stop.poi.lon) for stop in stops]), "haversine"


def _order_summary(graphhopper: GraphHopperClient, stops: list[RouteStop], profile: str) -> tuple[OrderSummary, list | None]:
    """Distance and time for the stops in this order, and the line when GraphHopper can route it."""
    poi_ids = [stop.poi_id for stop in stops]
    points = [[stop.poi.lon, stop.poi.lat] for stop in stops]
    try:
        result = graphhopper.route(points, profile)
    except RoutingError:
        return OrderSummary(poi_ids=poi_ids, distance_m=None, time_s=None), None
    return OrderSummary(poi_ids=poi_ids, distance_m=result.distance_m, time_s=result.time_s), result.geometry


@router.post("/{route_id}/optimize-preview", response_model=OptimizePreviewOut)
def preview_optimize(
    route_id: int,
    replace_imported: bool = False,
    session: Session = Depends(get_session),
    graphhopper: GraphHopperClient = Depends(get_graphhopper),
):
    """Propose the optimize order and its totals without saving anything.

    The stored route is unchanged. The UI shows both orders and accepts by PATCHing poi_ids. Under three
    stops there is nothing to reorder, so the proposed order is the current one with source "none".
    """
    route = get_or_404(session, Route, route_id)
    _refuse_if_imported(route, replace_imported)
    stops: list[RouteStop] = list(route.stops)
    if len(stops) < 3:
        # Nothing to reorder. A route of two stops still gets its totals; fewer than two has none.
        if len(stops) < 2:
            empty = OrderSummary(poi_ids=[stop.poi_id for stop in stops], distance_m=None, time_s=None)
            return OptimizePreviewOut(source="none", current=empty, proposed=empty, geometry=None)
        current, geometry = _order_summary(graphhopper, stops, route.profile)
        return OptimizePreviewOut(source="none", current=current, proposed=current, geometry=geometry)

    matrix, source = _stop_matrix(graphhopper, stops, route.profile)
    order = best_order(matrix)
    current, _ = _order_summary(graphhopper, stops, route.profile)
    if order == list(range(len(stops))):
        return OptimizePreviewOut(source=source, current=current, proposed=current, geometry=None)
    proposed, geometry = _order_summary(graphhopper, [stops[i] for i in order], route.profile)
    return OptimizePreviewOut(source=source, current=current, proposed=proposed, geometry=geometry)


@router.post("/{route_id}/optimize", response_model=OptimizeOut)
def optimize_route(
    route_id: int,
    replace_imported: bool = False,
    session: Session = Depends(get_session),
    graphhopper: GraphHopperClient = Depends(get_graphhopper),
):
    """Reorder the stops for the shortest travel time and save it. The first stop stays as the start."""
    route = get_or_404(session, Route, route_id)
    _refuse_if_imported(route, replace_imported)
    stops: list[RouteStop] = list(route.stops)
    if len(stops) < 3:
        return OptimizeOut(route=route_out(route), source="none")

    matrix, source = _stop_matrix(graphhopper, stops, route.profile)
    route.stops = [stops[i] for i in best_order(matrix)]
    for position, stop in enumerate(route.stops):
        stop.position = position
    route.invalidate()
    session.commit()
    return OptimizeOut(route=route_out(route), source=source)
