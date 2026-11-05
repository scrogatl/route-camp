# route-camp

A self-hostable trip planner for points of interest (POIs), routes and multi-route plans. It is an open-source
take on the Garmin BaseCamp workflow: POIs are stored once and *referenced* by routes and plans, tags act as
folders, and routing is done by [GraphHopper](https://www.graphhopper.com/) on OpenStreetMap data, so it runs
with no paid services.

> Status: first draft / scaffold. Expect rough edges. See [Known gaps](#known-gaps).

## Quick start

Requirements: Docker with Compose v2. Nothing else is needed on the host.

```bash
docker compose up --build
```

Then open <http://localhost:5173>.

The first start is slow. It downloads the OSM extract for the region (about 350 MB for Georgia, USA) into
`./data/osm`, then GraphHopper builds its routing graph into `./data/graph-cache`. Watch progress with
`docker compose logs -f graphhopper`. Routing calls return an error until GraphHopper reports that it is running.
Later starts reuse both downloads and the graph cache.

Services:

| Service       | URL                        | Purpose                                      |
|---------------|----------------------------|----------------------------------------------|
| frontend      | http://localhost:5173      | Map UI (Vite dev server)                     |
| backend       | http://localhost:8000/docs | FastAPI app and interactive API docs         |
| graphhopper   | http://localhost:8989      | Routing HTTP API (`/route`, `/matrix`)       |

## Changing the region

Routing covers whatever OSM extract you point at. Copy `.env.example` to `.env` and edit:

```bash
OSM_URL=https://download.geofabrik.de/north-america/us/california-latest.osm.pbf
OSM_FILE=california-latest.osm.pbf
REGION_NAME=california
```

Then `docker compose up --build`. Use a new `REGION_NAME` for each region so each one gets its own graph cache.
Any Geofabrik extract works (<https://download.geofabrik.de/>). Bigger regions need more memory: raise `JAVA_OPTS`
for the `graphhopper` service in `docker-compose.yml` (it is `-Xms4g -Xmx4g` now).

Changing `graphhopper/config.yml` (profiles, custom models) needs a rebuild of the graph cache: delete the
`REGION_NAME` folder in `./data/graph-cache` and start again.

## Using the app

- **POIs**: click the map to add one. Tick POIs in the sidebar to select them (the marker turns orange).
  Use the tag filter to show a subset, or type a tag and press "Tag selected" to tag the ticked POIs.
- **Routes**: tick POIs in the order you want to visit them, give the route a name, choose a profile
  (`car` = fastest, `fun` = curvy secondary roads, avoids motorways), and press "Create from selected POIs".
  Then press **calc** to route it. Click the route name to draw it and see distance and time.
- **optimize**: reorders a route's stops for the shortest travel time (first stop stays as start). Calculate again afterwards.
- **GPX**: "Import GPX" turns waypoints into POIs and `rte` entries into routes. Each route's **GPX** link exports
  waypoints, route points and the calculated line as a track.

## Architecture

```
 browser ── Vite + MapLibre GL JS (frontend/)
    │  /api  (proxied by Vite)
    ▼
 FastAPI + SQLAlchemy (backend/app/)  ── SQLite file (or any SQLAlchemy URL)
    │  HTTP
    ▼
 GraphHopper (graphhopper/config.yml) ── OSM extract from Geofabrik
```

- `backend/app/models.py`: POIs, routes, plans, tags. A route holds ordered `RouteStop` rows pointing at POIs;
  a plan holds ordered `PlanRoute` rows pointing at routes. Tags are many-to-many with each item type.
- `backend/app/services.py`: shared logic (tag handling, setting stops, GPX import and export).
- `backend/app/routing.py`: GraphHopper client for `/route` (line for a route) and `/matrix` (travel-time table).
- `backend/app/optimize.py`: stop ordering (nearest-neighbour plus 2-opt). It uses GraphHopper's matrix, with a
  haversine fallback if GraphHopper is down.
- `backend/app/gpx.py`: pure GPX parsing and writing with `gpxpy`.
- `graphhopper/`: GraphHopper config and the `fun` custom model (`custom_models/fun.json`).
- `docker-compose.yml`: `osm-fetch` (one-shot download), `graphhopper`, `backend`, `frontend`.

### API

All endpoints live under `/api`. Interactive docs are at `/docs` on the backend.

- `GET|POST /pois`, `GET|PATCH|DELETE /pois/{id}`
- `GET|POST /routes`, `GET|PATCH|DELETE /routes/{id}`
- `POST /routes/{id}/calculate`, `POST /routes/{id}/optimize`, `GET /routes/{id}/gpx`
- `GET|POST /plans`, `GET|PATCH|DELETE /plans/{id}`
- `GET|POST /tags`, `DELETE /tags/{id}`, `GET /tags/{id}/items`,
  `POST /tags/{id}/items` (body `{kind, id}`), `DELETE /tags/{id}/items/{kind}/{item_id}`
- `POST /gpx/import` (multipart `file`)
- `GET /config` (map style and profiles for the frontend)

List endpoints accept `?tag=name` to filter.

### Configuration

Backend settings come from environment variables prefixed `ROUTE_CAMP_` (see `backend/app/config.py`):
`ROUTE_CAMP_DATABASE_URL`, `ROUTE_CAMP_GRAPHHOPPER_URL`, `ROUTE_CAMP_MAP_STYLE_URL`, `ROUTE_CAMP_CORS_ORIGINS`.
Postgres/PostGIS is a matter of changing `DATABASE_URL` and adding a driver such as `psycopg`.

## Development without Docker

Backend:

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pytest                      # tests do not need GraphHopper
uvicorn app.main:app --reload
```

Frontend (needs Node 20+; the backend should be on :8000, or set `BACKEND_URL`):

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

## Known gaps

- Tracks (`trk`) in imported GPX files are skipped. Only waypoints and routes are imported.
- Plans have an API but no UI yet.
- Stop optimization uses a nearest-neighbour plus 2-opt heuristic. OR-Tools or VROOM would be better for larger problems.
- The frontend runs the Vite dev server in Docker. A static build behind nginx is still to do.
- No authentication. Anyone who can reach the backend can change the data.
- SQLite with synchronous SQLAlchemy calls inside FastAPI handlers. Fine for one user, not for heavy concurrent use.
