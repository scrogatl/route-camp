from app.models import POI, Plan, PlanRoute, Route, RouteStop
from app.schemas import plan_out, route_out
from app.stop_time import set_default_stop_minutes


def _poi(client, name: str, **extra) -> dict:
    response = client.post("/api/pois", json={"name": name, "lat": 34.5, "lon": -83.5, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def _route(session, pois: list[POI], time_s: float | None = 3600) -> Route:
    route = Route(name="Day 1", time_s=time_s, stops=[RouteStop(poi=p, position=n) for n, p in enumerate(pois)])
    session.add(route)
    session.commit()
    return route


def test_default_stop_minutes_is_five_and_can_be_changed(client):
    assert client.get("/api/settings").json()["stop_minutes"] == 5
    assert client.patch("/api/settings", json={"stop_minutes": 8}).json()["stop_minutes"] == 8
    assert client.get("/api/settings").json()["stop_minutes"] == 8
    assert client.patch("/api/settings", json={"stop_minutes": -1}).status_code == 422


def test_start_time_defaults_to_eight_and_can_be_changed(client):
    assert client.get("/api/settings").json() == {"stop_minutes": 5, "start_minutes": 480}
    assert client.patch("/api/settings", json={"start_minutes": 390}).json() == {"stop_minutes": 5, "start_minutes": 390}
    assert client.get("/api/settings").json()["start_minutes"] == 390
    assert client.patch("/api/settings", json={"start_minutes": 1440}).status_code == 422


def test_route_counts_middle_stops_at_the_default(client):
    hq, a, b = (_poi(client, n)["id"] for n in ("Rally HQ", "ABAC", "BENH"))
    route = client.post("/api/routes", json={"name": "R", "poi_ids": [hq, a, b, hq]}).json()
    assert route["stop_s"] == 2 * 5 * 60  # ABAC and BENH; not HQ at either end
    assert route["total_s"] is None  # not calculated, so no driving time to add to

    client.patch("/api/settings", json={"stop_minutes": 10})
    assert client.get(f"/api/routes/{route['id']}").json()["stop_s"] == 2 * 10 * 60


def test_a_poi_with_its_own_minutes_overrides_the_default(client):
    hq = _poi(client, "Rally HQ")["id"]
    slow = _poi(client, "PARK", stop_minutes=20)
    assert slow["stop_minutes"] == 20
    quick = _poi(client, "QUIK")["id"]
    route = client.post("/api/routes", json={"name": "R", "poi_ids": [hq, slow["id"], quick, hq]}).json()
    assert route["stop_s"] == (20 + 5) * 60

    # An explicit null goes back to the default
    assert client.patch(f"/api/pois/{slow['id']}", json={"stop_minutes": None}).json()["stop_minutes"] is None
    assert client.get(f"/api/routes/{route['id']}").json()["stop_s"] == 2 * 5 * 60


def test_end_stops_count_only_with_their_own_minutes(db_session):
    start, middle, finish = POI(name="S", lat=0, lon=0), POI(name="M", lat=0, lon=0), POI(name="F", lat=0, lon=0)
    finish.stop_minutes = 15
    route = _route(db_session, [start, middle, finish])
    out = route_out(route)
    assert out.stop_s == (5 + 15) * 60
    assert out.total_s == 3600 + out.stop_s


def test_plan_adds_stop_time_of_routes_with_driving_time(db_session):
    set_default_stop_minutes(db_session, 6)
    pois = [POI(name=n, lat=0, lon=0) for n in "ABC"]
    timed = _route(db_session, pois, time_s=3600)
    untimed = _route(db_session, pois, time_s=None)  # e.g. an imported GPX track
    plan = Plan(name="Trip", route_links=[PlanRoute(route=timed, position=0), PlanRoute(route=untimed, position=1)])
    db_session.add(plan)
    db_session.commit()
    out = plan_out(plan)
    assert out.time_s == 3600 and out.stop_s == 6 * 60 and out.total_s == 3600 + 6 * 60
