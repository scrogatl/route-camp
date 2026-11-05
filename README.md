# route-camp

A self-hostable trip planner for points of interest (POIs), routes and multi-route plans. It is an open-source
take on the Garmin BaseCamp workflow: POIs are stored once and *referenced* by routes and plans, tags act as
folders, and routing is done by [GraphHopper](https://www.graphhopper.com/) on OpenStreetMap data, so it runs
with no paid services.

The full design, rules and rebuild notes are in [docs/SPEC.md](docs/SPEC.md).

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

Services (host ports can be changed with `BACKEND_PORT` and `FRONTEND_PORT` in `.env`):

| Service       | URL                        | Purpose                                      |
|---------------|----------------------------|----------------------------------------------|
| frontend      | http://localhost:5173      | Map UI: static build served by nginx         |
| backend       | http://localhost:8080/docs | FastAPI app and interactive API docs         |
| graphhopper   | http://localhost:8989      | Routing HTTP API (`/route`)                  |

The production frontend is an nginx image built from `frontend/Dockerfile`. nginx serves the static bundle and
proxies `/api` to the backend, so the browser talks to one origin. Compose starts the backend before the
frontend, so nginx can resolve the `backend` name.

### Development with hot reload

For frontend work, run the Vite dev server instead, using the override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Vite serves on the same port (5173), proxies `/api` to the backend, and reloads on save. Bring it down and run
`docker compose up --build` to go back to the production build.

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
- **Plans**: a plan is an ordered list of routes. Create one in the Plans section, then add routes with the
  dropdown and reorder them with ↑ and ↓. The totals sum the routes that have a distance, and the time total
  only counts routes that have a time. Rename, tag or delete plans with their buttons. Deleting a plan keeps its routes.
  The tag filter also filters plans.
- **GPX import**: "Import GPX" reads waypoints, `rte` entries and `trk` tracks.
  - Waypoints become POIs. A POI with the same name and position is reused.
  - An `rte` becomes a route over its POIs.
  - A `trk` becomes a route between its start and end POIs. Its line is stored as the route's geometry, simplified
    to at most 2000 points. If a `trk` starts and ends at an `rte` of the same name, its line is attached to that
    route instead of making a second one.
  - Re-importing the same file creates nothing new. Routes match on name and ordered POIs, and tracks on name,
    start/end POIs and length (within 2%, or 500 m). The import message lists what was created and what was already there.
  - An imported track is marked as such. **calc** and **optimize** ask before replacing it, because calculating
    gives a GraphHopper line instead. Changing a route's stops or profile also clears the cached line.
  - Each route's **GPX** link exports waypoints, route points and the cached line as a track. The route points
    include Garmin shaping points about every 10 km along the line, so a Garmin that recalculates stays on the
    planned roads (`SHAPING_SPACING_KM` and `MAX_ROUTE_POINTS` in `.env`; see `docs/SPEC.md`).

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
- `backend/app/shaping.py`: picks Garmin shaping points along a route's line.
- `backend/app/routing.py`: GraphHopper client. `/route` gives the line for a route; a travel-time table is built from pairwise `/route` calls because this GraphHopper build has no `/matrix` endpoint.
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

- **Track segments are joined.** A `trk` with several segments becomes one line, and the gap between segments is not kept.
- **De-duplication is a heuristic.** Two different routes with the same name and the same POIs count as one.
  Tracks match on length within 2%. Re-importing edited files can therefore leave stale routes behind.
- **Plans have no map view.** A plan is a list and its totals; its routes are not drawn together.
- **Plan time totals can be partial.** An imported track has no time, so a plan with one shows "(partial)".
- **Stop optimization** uses nearest-neighbour plus 2-opt. OR-Tools or VROOM would do better on large problems.
- **Optimize and calculate** over an imported track need an explicit confirmation, which is done in the UI. The API
  needs `replace_imported=true`.
- **Routing uses pairwise `/route` calls** for the optimize matrix, because this GraphHopper build has no `/matrix`
  endpoint. That is O(n²) requests, so it is slow for very long routes.
- **The migration is minimal.** Startup adds missing nullable columns only. Anything else needs a migration tool.
- **GPX upload is not streamed.** A very large file is read into memory, and the handler is async but calls the
  synchronous database session.
- **No authentication.** Anyone who can reach the backend can change the data.
- **SQLite with synchronous SQLAlchemy calls** inside FastAPI handlers. Fine for one user, not for heavy concurrent use.
- **Graph cache files are root-owned** because the GraphHopper container runs as root. Deleting a region's cache needs `sudo`.
