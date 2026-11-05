from app.models import POI
from app.scores import backfill_scores, parse_score
from app.services import find_or_create_poi
from tests.helpers import gpx, import_gpx_bytes


def test_parse_score_reads_a_trailing_number_after_a_space():
    assert parse_score("TALU 669") == 669
    assert parse_score("ABAC 510") == 510
    assert parse_score("Camp 7 north") is None  # the number must end the name
    assert parse_score("TALU669") is None  # needs the space
    assert parse_score("Lake") is None
    assert parse_score("Big 1234567890") is None  # over nine digits is not a score


def test_backfill_fills_only_empty_scores(db_session):
    filled = POI(name="TALU 669", lat=34.5, lon=-83.5)
    kept = POI(name="ABAC 510", lat=34.6, lon=-83.4, score=5)  # already set: left alone
    plain = POI(name="Waterfall", lat=34.7, lon=-83.3)
    db_session.add_all([filled, kept, plain])
    db_session.flush()

    assert backfill_scores(db_session) == 1
    assert (filled.score, kept.score, plain.score) == (669, 5, None)

    # Running it again changes nothing.
    assert backfill_scores(db_session) == 0


def test_import_scores_new_pois_only(db_session):
    poi, created = find_or_create_poi(db_session, "ATL 12", 34.5, -83.5, None)
    assert created is True and poi.score == 12

    # An existing POI keeps the score it has, even if its name would give another one.
    poi.score = 99
    again, created = find_or_create_poi(db_session, "ATL 12", 34.5, -83.5, None)
    assert created is False and again.score == 99


def test_gpx_import_sets_scores_on_new_pois(client):
    body = (
        '<wpt lat="34.5" lon="-83.5"><name>TALU 669</name></wpt>'
        '<wpt lat="34.6" lon="-83.4"><name>Waterfall</name></wpt>'
    )
    import_gpx_bytes(client, gpx(body))
    scores = {poi["name"]: poi["score"] for poi in client.get("/api/pois").json()}
    assert scores == {"TALU 669": 669, "Waterfall": None}


def test_patch_sets_and_clears_score(client):
    poi = client.post("/api/pois", json={"name": "Camp", "lat": 34.5, "lon": -83.5, "score": 3}).json()
    assert poi["score"] == 3

    patched = client.patch(f"/api/pois/{poi['id']}", json={"score": 42}).json()
    assert patched["score"] == 42

    cleared = client.patch(f"/api/pois/{poi['id']}", json={"score": None}).json()
    assert cleared["score"] is None

    rejected = client.patch(f"/api/pois/{poi['id']}", json={"score": -1})
    assert rejected.status_code == 422
