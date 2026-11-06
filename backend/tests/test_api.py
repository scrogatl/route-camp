def _make_poi(client, name, lat, lon, tags=()):
    response = client.post("/api/pois", json={"name": name, "lat": lat, "lon": lon, "tags": list(tags)})
    assert response.status_code == 201, response.text
    return response.json()


def test_poi_crud_and_tag_filter(client):
    a = _make_poi(client, "Campsite", 34.5, -83.5, tags=["Camp"])
    _make_poi(client, "Waterfall", 34.6, -83.4)

    assert client.get("/api/pois").json()[0]["name"] == "Campsite"
    assert [p["id"] for p in client.get("/api/pois", params={"tag": "camp"}).json()] == [a["id"]]

    patched = client.patch(f"/api/pois/{a['id']}", json={"notes": "good shade"}).json()
    assert patched["notes"] == "good shade" and patched["tags"] == ["camp"]

    assert client.delete(f"/api/pois/{a['id']}").status_code == 204
    assert client.get(f"/api/pois/{a['id']}").status_code == 404


def test_route_with_pois_and_tag_items(client):
    a = _make_poi(client, "A", 34.5, -83.5)
    b = _make_poi(client, "B", 34.6, -83.4)
    route = client.post("/api/routes", json={"name": "Loop", "profile": "fun", "poi_ids": [b["id"], a["id"]]}).json()
    assert route["poi_ids"] == [b["id"], a["id"]]

    tag_id = client.post("/api/tags", json={"name": "weekend"}).json()["id"]
    assert client.post(f"/api/tags/{tag_id}/items", json={"kind": "route", "id": route["id"]}).status_code == 204
    tagged = client.get(f"/api/tags/{tag_id}/items").json()
    assert [r["id"] for r in tagged["routes"]] == [route["id"]]
    assert tagged["pois"] == []


def test_duplicate_route_copies_stops_tags_and_line(client):
    a = _make_poi(client, "A", 34.0, -84.0)
    b = _make_poi(client, "B", 34.1, -84.1)
    route = client.post(
        "/api/routes", json={"name": "Loop", "profile": "fun", "poi_ids": [a["id"], b["id"], a["id"]], "tags": ["day1"]}
    ).json()

    copy = client.post(f"/api/routes/{route['id']}/duplicate")
    assert copy.status_code == 201
    copy = copy.json()
    assert copy["id"] != route["id"]
    assert copy["name"] == "Loop (copy)"
    for field in ("profile", "poi_ids", "tags", "distance_m", "geometry", "geometry_source"):
        assert copy[field] == route[field]

    named = client.post(f"/api/routes/{route['id']}/duplicate", json={"name": "Loop B"}).json()
    assert named["name"] == "Loop B"

    # Renaming keeps the stops and the line.
    renamed = client.patch(f"/api/routes/{named['id']}", json={"name": "Loop C"}).json()
    assert (renamed["name"], renamed["poi_ids"], renamed["geometry"]) == ("Loop C", named["poi_ids"], named["geometry"])
    assert client.patch(f"/api/routes/{named['id']}", json={"name": ""}).status_code == 422

    # The copy is its own route: changing its stops leaves the original alone.
    client.patch(f"/api/routes/{copy['id']}", json={"poi_ids": [b["id"]]})
    assert client.get(f"/api/routes/{route['id']}").json()["poi_ids"] == [a["id"], b["id"], a["id"]]
    assert client.post("/api/routes/999/duplicate").status_code == 404


def test_unknown_poi_in_route_is_rejected(client):
    response = client.post("/api/routes", json={"name": "Bad", "poi_ids": [999]})
    assert response.status_code == 422


def test_calculate_reports_unreachable_graphhopper_as_502(client):
    a = _make_poi(client, "A", 34.5, -83.5)
    b = _make_poi(client, "B", 34.6, -83.4)
    route = client.post("/api/routes", json={"name": "Loop", "poi_ids": [a["id"], b["id"]]}).json()
    response = client.post(f"/api/routes/{route['id']}/calculate")
    assert response.status_code == 502


def test_gpx_import_and_export_over_http(client):
    gpx = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">'
        '<wpt lat="34.5" lon="-83.5"><name>Start</name></wpt>'
        '<wpt lat="34.6" lon="-83.4"><name>End</name></wpt>'
        '<rte><name>Day 1</name>'
        '<rtept lat="34.5" lon="-83.5"><name>Start</name></rtept>'
        '<rtept lat="34.6" lon="-83.4"><name>End</name></rtept>'
        "</rte></gpx>"
    )
    summary = client.post("/api/gpx/import", files={"file": ("trip.gpx", gpx, "application/gpx+xml")}).json()
    assert summary["pois_created"] == 2 and summary["pois_matched"] == 0
    assert summary["routes_created"] == 1 and summary["routes_matched"] == 0

    route = client.get("/api/routes").json()[0]
    exported = client.get(f"/api/routes/{route['id']}/gpx")
    assert exported.status_code == 200
    assert "<rtept" in exported.text and "Day 1" in exported.text
