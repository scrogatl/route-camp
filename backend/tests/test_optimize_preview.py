from app.geo import haversine_m
from app.optimize import haversine_time_matrix
from app.routing import RouteResult, RoutingError
from tests.helpers import routes

# Stops on one meridian, 0.1 degree (about 11 km) apart, listed as 0, 3, 1, 2.
LAT = [34.0, 34.3, 34.1, 34.2]


class FakeGraphHopper:
    """Straight-line routing, so totals are predictable. `fail=True` simulates GraphHopper being down."""

    def __init__(self, fail: bool = False):
        self.fail = fail

    def route(self, points, profile):
        if self.fail:
            raise RoutingError("down")
        pts = [(lat, lon) for lon, lat in points]
        distance = sum(haversine_m(a, b) for a, b in zip(pts, pts[1:]))
        return RouteResult(geometry=points, distance_m=distance, time_s=distance / 13.9)

    def matrix(self, points, profile):
        if self.fail:
            raise RoutingError("down")
        return haversine_time_matrix([(lat, lon) for lon, lat in points])

    def close(self):
        pass


def _route_with_stops(client, lats):
    ids = []
    for index, lat in enumerate(lats):
        poi = client.post("/api/pois", json={"name": f"P{index}", "lat": lat, "lon": -83.5}).json()
        ids.append(poi["id"])
    route = client.post("/api/routes", json={"name": "Preview", "profile": "car", "poi_ids": ids}).json()
    return route, ids


def test_preview_proposes_an_order_and_saves_nothing(client):
    client.app.state.graphhopper = FakeGraphHopper()
    route, ids = _route_with_stops(client, LAT)

    preview = client.post(f"/api/routes/{route['id']}/optimize-preview").json()

    assert preview["source"] == "graphhopper"
    assert preview["current"]["poi_ids"] == ids
    assert preview["proposed"]["poi_ids"] == [ids[0], ids[2], ids[3], ids[1]]
    assert preview["proposed"]["distance_m"] < preview["current"]["distance_m"]
    assert preview["geometry"] is not None
    # Nothing was saved: the route keeps its order and its cached line is still empty.
    stored = client.get(f"/api/routes/{route['id']}").json()
    assert stored["poi_ids"] == ids
    assert stored["geometry"] is None


def test_preview_of_an_already_best_route_proposes_the_same_order(client):
    client.app.state.graphhopper = FakeGraphHopper()
    route, ids = _route_with_stops(client, [34.0, 34.1, 34.2])

    preview = client.post(f"/api/routes/{route['id']}/optimize-preview").json()

    assert preview["proposed"] == preview["current"]
    assert preview["geometry"] is None


def test_preview_under_three_stops_says_nothing_to_reorder(client):
    client.app.state.graphhopper = FakeGraphHopper()
    route, ids = _route_with_stops(client, [34.0, 34.1])

    preview = client.post(f"/api/routes/{route['id']}/optimize-preview").json()

    assert preview["source"] == "none"
    assert preview["proposed"]["poi_ids"] == ids


def test_preview_falls_back_to_straight_line_without_graphhopper(client):
    client.app.state.graphhopper = FakeGraphHopper(fail=True)
    route, ids = _route_with_stops(client, LAT)

    preview = client.post(f"/api/routes/{route['id']}/optimize-preview").json()

    assert preview["source"] == "haversine"
    assert preview["proposed"]["poi_ids"] == [ids[0], ids[2], ids[3], ids[1]]
    assert preview["proposed"]["distance_m"] is None and preview["current"]["time_s"] is None


def test_preview_refuses_an_imported_track_without_replace_flag(client):
    client.app.state.graphhopper = FakeGraphHopper()
    route, _ = _route_with_stops(client, LAT)
    # Give the route an imported line, as a GPX track import would.
    from app.database import SessionLocal
    from app.models import Route as RouteModel

    with SessionLocal() as session:
        stored = session.get(RouteModel, route["id"])
        stored.geometry = [[-83.5, 34.0], [-83.5, 34.3]]
        stored.geometry_source = "imported"
        session.commit()

    assert client.post(f"/api/routes/{route['id']}/optimize-preview").status_code == 409
    assert client.post(f"/api/routes/{route['id']}/optimize-preview?replace_imported=true").status_code == 200


def test_apply_optimize_still_saves_the_order(client):
    client.app.state.graphhopper = FakeGraphHopper()
    route, ids = _route_with_stops(client, LAT)

    saved = client.post(f"/api/routes/{route['id']}/optimize").json()

    assert saved["route"]["poi_ids"] == [ids[0], ids[2], ids[3], ids[1]]
    assert routes(client)[0]["poi_ids"] == [ids[0], ids[2], ids[3], ids[1]]
