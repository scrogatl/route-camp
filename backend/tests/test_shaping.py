from sqlalchemy import select

from app.geo import haversine_m
from app.gpx import parse_gpx
from app.models import POI, Route
from app.services import export_route_gpx, import_gpx, set_route_stops
from app.shaping import shaping_points

# A straight north-south line, one vertex about every 1.1 km (0.01 degrees of latitude), about 110 km long.
LINE = [(34.0 + i * 0.01, -84.0) for i in range(101)]
START, MIDDLE, END = LINE[0], LINE[50], LINE[-1]


def test_points_are_spaced_along_the_line_and_kept_off_the_stops():
    [leg] = shaping_points(LINE, [START, END], spacing_m=10_000, max_route_points=50)
    assert 8 <= len(leg) <= 11
    assert all(point in LINE for point in leg)  # vertices of the line, so they sit on the road
    assert min(haversine_m(p, START) for p in leg) >= 5_000
    assert min(haversine_m(p, END) for p in leg) >= 5_000
    gaps = [haversine_m(a, b) for a, b in zip(leg, leg[1:])]
    assert all(9_000 <= gap <= 12_000 for gap in gaps)


def test_one_list_per_leg_in_order():
    legs = shaping_points(LINE, [START, MIDDLE, END], spacing_m=10_000, max_route_points=50)
    assert len(legs) == 2
    assert all(p[0] < MIDDLE[0] for p in legs[0])
    assert all(p[0] > MIDDLE[0] for p in legs[1])


def test_spacing_widens_to_fit_the_route_point_budget():
    legs = shaping_points(LINE, [START, END], spacing_m=1_000, max_route_points=6)
    assert sum(len(leg) for leg in legs) <= 4  # 6 route points minus the 2 stops


def test_zero_spacing_turns_shaping_off():
    assert shaping_points(LINE, [START, MIDDLE, END], spacing_m=0, max_route_points=50) == [[], []]


def _route(db_session) -> Route:
    a = POI(name="Start", lat=START[0], lon=START[1])
    b = POI(name="End", lat=END[0], lon=END[1])
    db_session.add_all([a, b])
    db_session.flush()
    route = Route(name="Long road", profile="fun")
    db_session.add(route)
    set_route_stops(db_session, route, [a.id, b.id])
    route.geometry = [[lon, lat] for lat, lon in LINE]
    db_session.commit()
    return route


def test_export_marks_stops_as_via_points_and_extra_points_as_shaping(db_session):
    xml = export_route_gpx(_route(db_session), shaping_spacing_m=10_000, max_route_points=50)
    [gpx_route] = parse_gpx(xml).routes
    assert gpx_route.points[0].name == "Start" and not gpx_route.points[0].shaping
    assert gpx_route.points[-1].name == "End" and not gpx_route.points[-1].shaping
    middle = gpx_route.points[1:-1]
    assert middle and all(p.shaping for p in middle)
    assert "trp:ViaPoint" in xml and "trp:ShapingPoint" in xml


def test_reimporting_an_export_with_shaping_points_creates_no_pois_or_routes(db_session):
    xml = export_route_gpx(_route(db_session), shaping_spacing_m=10_000, max_route_points=50)
    summary = import_gpx(db_session, parse_gpx(xml))
    db_session.commit()
    assert summary.pois_created == 0
    assert [r.status for r in summary.routes] == ["matched"]
    assert len(db_session.scalars(select(POI)).all()) == 2
    assert len(db_session.scalars(select(Route)).all()) == 1
