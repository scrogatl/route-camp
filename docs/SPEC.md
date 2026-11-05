# route-camp specification

This spec lets a reader (human or AI) understand route-camp, or rebuild it from scratch, without the
original conversation. It describes what exists as of November 2026, why it was built that way, and
the traps hit along the way. The code is the final authority; update this file when the design changes.

## 1. Purpose

route-camp is a self-hostable, open-source replacement for the trip-planning parts of Garmin BaseCamp:
keep a library of places, build routes through them on real roads, group routes into plans, and move
everything to and from a Garmin GPS as GPX.

It was started because BaseCamp is ageing (Garmin's messaging about discontinuation is mixed, and
future macOS releases won't support it) and nothing else combines a POI library, folders and route
planning in one free tool.

### Core principles (requirements, not suggestions)

1. **POIs exist on their own.** A POI is stored once. Routes and plans *reference* POIs by id, never
   copy them. Editing a POI changes it everywhere it is used.
2. **Folders are labels.** Every item (POI, route, plan) is unique. A "folder" is a tag. An item can carry
   any number of tags, and a tag can hold any mix of item types.
3. **Route finding uses existing tools.** Road routing, map tiles and map data come from free,
   open-source projects (GraphHopper, OpenStreetMap, MapLibre, OpenFreeMap). route-camp is the glue and
   the UI, not a routing engine.
4. **Runs on the web or on a laptop from one codebase.** The same `docker compose up` works on a
   single machine or a server; what changes is configuration (database URL, map region, tile source).

## 2. Architecture

```
browser ──► frontend (nginx :80, published on host :5173)
              ├─ static bundle (Vite + TypeScript + MapLibre GL)
              └─ /api/* proxied ──► backend (FastAPI :8000, published on host :8080)
                                       ├─ SQLite file in ./data/db (SQLAlchemy; Postgres-ready)
                                       └─ HTTP ──► graphhopper (:8989, admin :8990)
                                                     └─ graph built from ./data/osm/<region>.osm.pbf
osm-fetch (one-shot alpine container): downloads the OSM extract into ./data/osm if missing
```

- All four services are in `docker-compose.yml`. Startup order: `osm-fetch` must finish successfully,
  then `graphhopper`, then `backend`, then `frontend`.
- The browser only ever talks to one origin (the frontend). nginx proxies `/api/` to the backend, so
  there is no CORS in production. (CORS settings exist for the Vite dev server.)
- Java and the GitHub CLI are not needed on the host. Everything runs in containers.

### Stack and why

| Part | Choice | Why |
|---|---|---|
| Backend | Python 3.12, FastAPI, SQLAlchemy 2.x, pydantic-settings, httpx, gpxpy | Familiar, quick to build, good GPX library |
| Database | SQLite by default (lat/lon as plain floats, no SpatiaLite) | Single file for laptop use; `ROUTE_CAMP_DATABASE_URL` switches to Postgres |
| Routing | GraphHopper, Docker image `israelhikingmap/graphhopper:latest` | Apache-2.0, custom models for a "fun" profile, runs on a laptop for one US state |
| Map data | Geofabrik OSM extract (default Georgia, USA) | Free, per-region downloads |
| Map display | MapLibre GL JS 4.x, OpenFreeMap "liberty" style | Free tiles, no API key |
| Frontend | Plain TypeScript + Vite 5 (no framework) | Small app; fewer moving parts |
| Serving | nginx 1.27 (multi-stage build), Vite dev server as an override | Production build plus hot reload when developing |

## 3. Data model

Tables (see `backend/app/models.py`):

- **tags**: `id`, `name` (unique). Names are normalised to trimmed lowercase.
- **pois**: `id`, `name`, `lat`, `lon`, `notes?`, `created_at`, `updated_at`.
- **routes**: `id`, `name`, `notes?`, `profile` (`car` | `fun`), cached line fields:
  `distance_m?`, `time_s?`, `geometry?` (JSON `[[lon, lat], ...]`), `geometry_source?`
  (`calculated` | `imported`), `calculated_at?`, timestamps.
- **route_stops**: `route_id`, `poi_id`, `position`. The ordered POI references of a route.
  A POI may appear more than once in a route.
- **plans**: `id`, `name`, `notes?`, timestamps.
- **plan_routes**: `plan_id`, `route_id`, `position`. The ordered route references of a plan.
- **poi_tags**, **route_tags**, **plan_tags**: many-to-many link tables.

All foreign keys use `ON DELETE CASCADE`. SQLite needs `PRAGMA foreign_keys=ON` on every connection
(done in `database.py`), otherwise cascades silently don't happen. Effects:

- Deleting a POI removes it from every route that used it (that stop disappears).
- Deleting a route removes it from every plan. The plan itself is kept.
- Deleting a plan keeps its routes. Deleting a tag only removes the label.

### Rules

- **Cache invalidation:** changing a route's stops or profile clears its cached line
  (`Route.invalidate()`). Renaming or tagging does not.
- **Imported tracks are protected:** a route whose `geometry_source` is `imported` (from a GPX `trk`)
  is never recalculated or reordered by accident. `calculate` and `optimize` return 409 unless called
  with `replace_imported=true`; the UI asks the user first.
- **Plan totals** add up `distance_m` and `time_s` over the plan's routes that have them, and report
  how many routes have a distance or time, so the UI can say "partial".

### Schema changes

There is no Alembic yet. On startup `database.configure()` runs `create_all` and then adds any
**nullable** column that a model has and the table lacks. A non-nullable new column raises an error on
purpose. Anything beyond adding nullable columns should introduce Alembic.

## 4. Backend API

All under `/api`. Interactive docs at `http://localhost:8080/docs`.

| Method and path | Purpose |
|---|---|
| `GET /config` | `{map_style_url, routing_profiles: ["car","fun"]}` for the frontend |
| `GET /pois?tag=` · `POST /pois` · `GET/PATCH/DELETE /pois/{id}` | POI CRUD; `tags: [names]` accepted on create/update |
| `GET /routes` · `POST /routes` · `GET/PATCH/DELETE /routes/{id}` | Route CRUD; body has `name`, `profile`, `poi_ids` (ordered), `tags` |
| `POST /routes/{id}/calculate?replace_imported=` | GraphHopper line through the stops in order; caches geometry, distance, time. 422 if fewer than 2 stops, 502 if GraphHopper fails |
| `POST /routes/{id}/optimize?replace_imported=` | Reorders stops for least travel time, first stop fixed; returns `{route, source}` where source is `graphhopper`, `haversine` or `none` (under 3 stops). Clears the cached line |
| `GET /plans` · `POST /plans` · `GET/PATCH/DELETE /plans/{id}` | Plan CRUD; `route_ids` (ordered) and `tags` |
| `GET /tags` · `POST /tags` · `DELETE /tags/{id}` | Tag list; create is idempotent by name |
| `GET /tags/{id}/items` | All POIs, routes and plans with that tag |
| `POST /tags/{id}/items` `{kind, id}` · `DELETE /tags/{id}/items/{kind}/{item_id}` | Tag / untag any item |
| `POST /gpx/import` (multipart `file`) | Import a GPX file; returns what was created vs. matched |
| `GET /routes/{id}/gpx` | Download a route as GPX |

### Routing (`backend/app/routing.py`)

- `POST {graphhopper}/route` with `points` as `[lon, lat]`, `profile`, `points_encoded: false`,
  `instructions: false`.
- The GraphHopper image in use has **no `/matrix` endpoint** (it returns 404). The travel-time matrix for
  optimize is built from one `/route` call per ordered pair (`calc_points: false`). That is O(n²) calls,
  fine for a trip's worth of stops. Unreachable legs are `inf`.
- If GraphHopper is down, optimize falls back to straight-line distance at about 50 km/h.

### Stop ordering (`backend/app/optimize.py`)

Nearest-neighbour from the first stop, then 2-opt until no improvement. Open path (no return to
start). OR-Tools or VROOM is the planned upgrade when time windows, a return leg or scoring are needed.

### GPX import rules (`backend/app/services.py`)

1. **Waypoints (`wpt`) become POIs.** An existing POI is reused when the name matches and lat/lon are
   within 1e-6°. Within one file, points at the same rounded coordinate share a POI.
2. **Routes (`rte`) become routes** over the POIs of their route points (each `rtept` is resolved to a
   POI the same way). Re-import matches an existing route with the same name and the same ordered POI ids.
3. **Tracks (`trk`)**, all segments joined:
   - If the file also has an `rte` with the same name, and the track's start and end are within 500 m
     of that route's first and last points, the track's line is attached to that route (if it has none).
     This is what route-camp's own exports look like, so an export re-imports cleanly.
   - Otherwise the track becomes a two-stop route: POIs "`<name>` start" and "`<name>` end", with the
     track as its cached line (`geometry_source = imported`), simplified with Douglas-Peucker to at most
     2,000 points. Re-import matches on name, the same start/end POIs, and length within 2% or 500 m.
4. The response lists POIs created/matched and each route with `created` or `matched`.

### GPX export

One file per route: `wpt` for each unique POI, one `rte` with the stops in order, and a `trk` with the
cached line when there is one. Creator is `route-camp`. **Verified on a Garmin zūmo 396:** the file
imports as a trip and matches the planned line. On a real ride (November 2026, route "Walmart-Nav-Test")
the device recalculated the route while navigating. That was acceptable, but exporting extra shaping
points along the line, so the device holds the planned roads, stays on the roadmap (section 9).

## 5. GraphHopper setup

Files: `graphhopper/config.yml`, `graphhopper/custom_models/fun.json`, `scripts/fetch-osm.sh`.

- Two profiles, both with contraction hierarchies (`profiles_ch`), none with landmarks:
  - `car`: `custom_model_files: [car.json]` (GraphHopper's built-in car model).
  - `fun`: `custom_model_files: [car.json, fun.json]`.
- `fun.json`: `distance_influence: 70`; priority multiplied by 0.05 on motorways, 0.2 on trunk roads,
  0.6 on primary, 1.3 on secondary and tertiary. Expect fun routes to be somewhat longer and much
  slower than car (one test: 288 km / 242 min by car vs. 303 km / 350 min fun).
- `graph.encoded_values`: `car_access, car_average_speed, country, road_class, roundabout, max_speed,
  road_environment, ferry_speed`.
- `import.osm.ignored_highways: footway,construction,cycleway,path,steps` (both profiles are motorised,
  so this makes the import smaller and faster).
- JVM: `-Xms4g -Xmx4g`. One US state imports in minutes on an 8-core, 24 GB laptop.
- The OSM file and graph folder are passed on the command line (`-i`, `-o`, `-c`) so the region can
  change through `.env` alone.

Config traps found while building it (each one cost a failed start):
- Logging needs `target: STDOUT` on the console appender.
- Set `datareader.file` and `graph.location` explicitly, even though the command line overrides them.
- `ferry_speed` must be in `graph.encoded_values` for the car model.
- A custom model JSON must not contain a `description` key.
- Changing profiles or the custom model requires deleting the graph cache
  (`data/graph-cache/<region>`) so the graph is rebuilt. These files are owned by root (the container
  runs as root), so deleting them needs `sudo`.

## 6. Frontend

Files: `frontend/index.html`, `src/main.ts` (app), `src/api.ts` (typed API client), `src/dialogs.ts`,
`src/style.css`.

- One page: a sidebar on the left (GPX, POIs, new route, routes, plans) and the map filling the rest.
  On narrow screens the sidebar stacks above the map.
- State is minimal; the server is the source of truth and `refresh()` reloads everything after each
  change. DOM is built with a small `h()` helper that sets user text as text, never HTML.
- **POIs:** markers on the map; click the map to add a POI (asks for a name); tick POIs in the list
  (tick order is route order); filter by tag; tag the ticked POIs; delete.
- **Routes:** create from ticked POIs with a profile; per route: show (click name), calc, optimize, GPX
  download, delete. Showing a route draws its line and fits the map to it. **Clear map** hides the line
  and unticks everything without deleting anything.
- **Plans:** create, rename, edit tags, delete; add routes, reorder (up/down), remove; totals shown.
- **Dialogs:** never use `alert`, `confirm` or `prompt`. Embedded browsers (including the Claude
  desktop app's browser pane) block them, and `confirm()` then returns false, which made delete buttons
  silently do nothing. `dialogs.ts` provides `showMessage`, `askConfirm` and `askText` on a `<dialog>`.
- Light and dark themes through CSS variables and `prefers-color-scheme`.
- **Caching:** nginx sends `Cache-Control: no-cache` for `index.html` and long-lived caching for
  `/assets/` (Vite gives assets content-hashed names). Without the `no-cache`, browsers kept showing
  the old page after a rebuild.

## 7. Configuration and running

`.env` (copy from `.env.example`; everything optional):

| Variable | Default | Meaning |
|---|---|---|
| `OSM_URL` | Geofabrik Georgia extract | Region to download |
| `OSM_FILE` | `georgia-latest.osm.pbf` | File name in `data/osm` |
| `REGION_NAME` | `georgia` | Graph-cache folder; change with the region |
| `MAP_STYLE_URL` | OpenFreeMap liberty | Basemap style |
| `BACKEND_PORT` | `8080` | Host port (8000 is often taken) |
| `FRONTEND_PORT` | `5173` | Host port for the app |

Backend settings use the `ROUTE_CAMP_` prefix: `DATABASE_URL`, `GRAPHHOPPER_URL`, `MAP_STYLE_URL`,
`CORS_ORIGINS`.

```bash
docker compose up -d --build                                              # production build
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build # Vite dev server, hot reload
docker compose exec backend python -m pytest -q                           # tests
```

Data lives in `./data` (git-ignored): `osm/` (extract), `graph-cache/` (GraphHopper), `db/` (SQLite).

## 8. Tests

`backend/tests`, 30 tests, none need GraphHopper (it is faked): models and cascades, geometry
(haversine, simplification), GPX parse/build round trip, optimize, the REST API, plans API (totals,
reorder, tags), track import and re-import de-duplication. There are no frontend tests; UI checks were
done by hand in a browser.

## 9. Known gaps and next steps

- Garmin shaping points: export extra shaping points along the calculated line (not just the POI
  stops) so the device's recalculation stays on the planned roads, especially "fun" back roads.
- The "fun" profile only re-weights road classes. A curvature-based model would be closer to Kurviger.
- Route names get cut off in the sidebar because the row's buttons take most of the width.
- No login, single user. Before hosting publicly: add auth, move to Postgres, add Alembic, and pick a
  tile source with terms suitable for the traffic.
- Sync SQLAlchemy runs inside FastAPI handlers (fine for one user); GPX import reads the whole file into
  memory.
- No offline tiles (PMTiles would allow it), no POI editing UI beyond create/delete, no bulk actions.
- Optimize keeps the first stop fixed and has no return leg, time windows or scoring.

## 10. Rebuilding from scratch

A sensible order, each step testable on its own:

1. Data model, settings and database wiring with SQLite foreign keys on; model tests.
2. GPX parse/build as pure functions; round-trip tests.
3. REST API for POIs, routes, plans and tags; GPX import/export with the de-dup rules above; API tests
   with a fake routing client.
4. GraphHopper container with the config in section 5, the OSM fetch step, and the routing client.
   Confirm with `curl "localhost:8989/route?point=33.749,-84.388&point=34.0,-84.0&profile=car"`.
5. Calculate and optimize endpoints (pairwise matrix, 2-opt).
6. Frontend: map and POIs, then routes, then plans, with in-page dialogs from the start.
7. nginx production image with the `/api` proxy and cache headers; Vite dev override.
8. Export a route, load it on the Garmin, compare it with the map, then ride it.

## History

- Repository: https://github.com/scrogatl/route-camp (branch `main`).
- November 2026: feasibility review, then first draft scaffolded by a Claude Haiku session; round 2
  added plans UI, track import, de-dup and the nginx build; then in-page dialogs and Clear map.
