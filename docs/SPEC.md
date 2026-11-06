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
- **pois**: `id`, `name`, `lat`, `lon`, `notes?`, `score?` (integer), `state?` (text such as "GA", from a
  rally CSV), `stop_minutes?` (its own minutes at the stop; null means the default), `created_at`, `updated_at`.
- **routes**: `id`, `name`, `notes?`, `profile` (`car` | `fun`), cached line fields:
  `distance_m?`, `time_s?`, `geometry?` (JSON `[[lon, lat], ...]`), `geometry_source?`
  (`calculated` | `imported`), `legs?` (JSON `[{distance_m, time_s}, ...]`, one per leg), `calculated_at?`, timestamps.
- **route_stops**: `route_id`, `poi_id`, `position`. The ordered POI references of a route.
  A POI may appear more than once in a route.
- **plans**: `id`, `name`, `notes?`, timestamps.
- **app_settings**: `key`, `value` (number). Holds `stop_minutes`, the default minutes at each stop
  (5 when the row is missing), and `start_minutes`, the rally start in minutes after midnight (480 = 08:00
  when missing).
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
- **Scores:** a POI's `score` is the number at the end of its name after a space ("TALU 669" -> 669;
  `backend/app/scores.py`). Set on GPX import for new POIs only, and by the one-off backfill
  `python -m app.backfill_scores`, which fills only empty scores and is never run at startup (so a
  cleared score stays cleared). Edits through the API are explicit; nothing re-parses names.
- **Rally CSV import** (`backend/app/rally.py`, `import_rally_bonuses()` in `services.py`): the file is
  rally-route-finder's `bonus-lat-lon-points.csv`, no header (a first line whose lat field starts with
  "lat" is skipped), one bonus per line: `code, lat, lon, points, state, , ` (trailing fields unused).
  A state of `N/A` or blank is stored as null. Each bonus matches an existing POI whose name is the code
  alone ("ABAC") or the code, a space and more ("ABAC 510", as GPX-imported rally POIs are named), with
  lat/lon within 1e-6°, the GPX tolerance. A match gets the file's points as `score` and its state; its
  name, tags and notes are never changed. No match creates a POI named by the code, with points and
  state. A malformed line is a 422 naming the line. The response counts created, matched and updated
  (matched POIs whose points or state changed).
- **Stop time** (`backend/app/stop_time.py`): `time_s` is driving time only. Each route also reports
  `stop_s`, the time at its stops, and `total_s` = `time_s` + `stop_s` (null without a driving time).
  Every stop takes its POI's own `stop_minutes`, else the default (`app_settings.stop_minutes`). The
  first and last stops are where the ride starts and ends (Rally HQ), so they count only with their own
  minutes, as rally-route-finder counts them. A POI used twice in a route counts each time. Both are
  computed when a route is read, so changing the default or a POI's minutes changes every route at once
  and needs no recalculation.
- **Plan totals** add up `distance_m` and `time_s` over the plan's routes that have them, plus `stop_s`
  of the routes that have a driving time, with `total_s` = `time_s` + `stop_s`; they report
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
| `GET /pois?tag=` · `POST /pois` · `GET/PATCH/DELETE /pois/{id}` | POI CRUD; `tags: [names]`, `score` (0 or more, or null), `state` and `stop_minutes` (0 to 1440, or null) accepted on create/update. PATCH with `score: null` clears it; `stop_minutes: null` goes back to the default |
| `GET /routes` · `POST /routes` · `GET/PATCH/DELETE /routes/{id}` | Route CRUD; body has `name`, `profile`, `poi_ids` (ordered), `tags`. Responses add `stop_s` and `total_s` |
| `GET /settings` · `PATCH /settings` `{stop_minutes, start_minutes}` | The default minutes at each stop (0 to 1440), and the rally start in minutes after midnight (0 to 1439, default 480 = 08:00) for the route table |
| `POST /routes/{id}/duplicate` `{name?}` | Copies the route: stops, tags, profile, notes and cached line (an imported GPX track too). The copy is named `name`, or "<name> (copy)" without one. 201 with the new route |
| `POST /routes/{id}/calculate?replace_imported=` | GraphHopper line through the stops in order; caches geometry, distance, time, and `legs` (`[{distance_m, time_s}]`, one per pair of consecutive stops, split at GraphHopper's via-point instructions). Anything that clears the line clears `legs`; an imported GPX track has none. 422 if fewer than 2 stops, 502 if GraphHopper fails |
| `POST /routes/{id}/optimize?replace_imported=` | Reorders stops for least travel time, first stop fixed, and saves it; returns `{route, source}` where source is `graphhopper`, `haversine` or `none` (under 3 stops). Clears the cached line |
| `POST /routes/{id}/optimize-preview?replace_imported=` | The same ordering, saves nothing. Returns `{source, current, proposed, geometry}`: each of `current` and `proposed` is `{poi_ids, distance_m, time_s}` (totals null when GraphHopper cannot route that order), and `geometry` is the proposed line. The UI accepts by PATCHing `poi_ids` and then calling `calculate` |
| `PATCH /routes/{id}` `{poi_ids}` | Replaces the stops in order (used for moving, removing and accepting a proposed order). Clears the cached line |
| `GET /plans` · `POST /plans` · `GET/PATCH/DELETE /plans/{id}` | Plan CRUD; `route_ids` (ordered) and `tags` |
| `GET /tags` · `POST /tags` · `DELETE /tags/{id}` | Tag list; create is idempotent by name |
| `GET /tags/{id}/items` | All POIs, routes and plans with that tag |
| `POST /tags/{id}/items` `{kind, id}` · `DELETE /tags/{id}/items/{kind}/{item_id}` | Tag / untag any item |
| `POST /gpx/import` (multipart `file`) | Import a GPX file; returns what was created vs. matched |
| `POST /rally/import` (multipart `file`) | Import a rally bonus CSV; returns `{bonuses, pois_created, pois_matched, pois_updated, created: [codes], updated: [names]}` |
| `GET /routes/{id}/gpx?shaping_km=` | Download a route as GPX; `shaping_km` overrides the shaping-point spacing (0 = none) |

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

1. **Waypoints (`wpt`) become POIs.** A new POI takes its score from a trailing number in its name (see
   the **Scores** rule in section 3). An existing POI is reused when the name matches and lat/lon are
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

One file per route: `wpt` for each unique POI, one `rte`, and a `trk` with the cached line when there
is one. Creator is `route-camp`.

The `rte` holds the stops in order, with **shaping points** between them when the route has a line
(`backend/app/shaping.py`):
- Each stop is marked as a Garmin via point and each extra point as a shaping point, using Garmin's
  trip extensions (namespace `http://www.garmin.com/xmlschemas/TripExtensions/v1`, prefix `trp`:
  `<trp:ViaPoint>` with `CalculationMode` FasterTime and `ElevationMode` Standard, or
  `<trp:ShapingPoint/>`). The device routes through shaping points without announcing them.
- Shaping points are vertices of the cached line, so they sit on the planned road. Each stop is matched
  to its nearest line vertex, never moving backwards along the line, which splits the line into legs.
- Within a leg, a point is taken roughly every `shaping_spacing_km` (default 10 km), and none closer
  than half a spacing to either stop. Short legs get none (an 8 km route gets no shaping points).
- Stops plus shaping points are kept within `max_route_points` (default 50) by widening the spacing
  by 25% at a time until they fit. The right limit for the zūmo 396 is not confirmed; lower it if the
  device rejects or trims a trip.
- Shaping points are named "Shaping 1", "Shaping 2", and so on.
- On import, route points marked `trp:ShapingPoint` are skipped: they never become POIs, so
  re-importing an export (or a BaseCamp file with shaping points) matches the existing route.

Example: the 301 km "Test1" route exports 2 stops and 28 shaping points.

**Garmin testing:** on a zūmo 396 the file imports as a trip and matches the planned line. On a real
ride (November 2026, route "Walmart-Nav-Test", exported before shaping points existed) the device
recalculated the route while navigating, which was acceptable. Shaping points were then added to
keep recalculation on the planned roads; they have not yet been ridden.

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

- **Look:** copied from the user's rally-route-finder (`webapp/static/style.css` there): CSS variables
  `--bg --card --text --muted --line --accent --accent-text --warn-bg --warn` for light and dark, a grey
  page with white cards (10 px radius), a header bar with brand and tagline, bold 13 px field labels with
  muted small hints, solid `.primary` buttons and outlined ones (the default here, because the sidebar
  has many small buttons; rally's default is solid), `.danger` (warning orange) on delete buttons, and
  sortable tables with numbers right-aligned. **Blue and orange only, no red/green pairs** (colour
  blindness): POI markers slate blue, ticked POIs orange, route line and stop numbers blue, the optimize
  preview dashed orange, plan colours alternate blues and oranges.
- **Two views**, switched by Map / Bonuses in the header (remembered under `route-camp.view`):
  - **Map:** a sidebar of cards on the left (Import, Selected, POIs, Routes, Plans) and the map filling
    the rest. On narrow screens the sidebar stacks above the map.
  - **Bonuses:** a full-width table of every POI with the Selected card beside it (below it on narrow
    screens). The same `#selected-card` element is moved between the two places by `setView()`.
- **One selection:** `state.selected` (POI ids in order) is shared by map markers, the POI folders, the
  Bonuses table and the Selected card. `renderSelection()` redraws all of them after any change. A
  ticked marker shows its number in the selection, in orange (stops of a shown route keep their blue
  stop numbers).
- **Bonuses table:** columns tick, code / name, points (`score`), state, stop min, tags, routes (how many routes
  the POI is on), notes. Click a heading to sort, again to reverse; numbers sort highest first, text A to
  Z, blanks last (remembered under `route-camp.bonus-sort`). A filter box matches name, state, notes and
  tags; a Tag picker narrows to one tag or Untagged. The status line reads "12 selected · 6,480 points ·
  showing 139 of 139". The header tick box and **Tick shown** / **Untick shown** act on the rows shown;
  ticking appends after the current selection in the table's order. A ticked row is tinted and shows its
  order number. Clicking a name switches to the map and flies there.
- **Stop time:** the Routes card has **Minutes at each stop**, the default for every stop (saved through
  `PATCH /settings`). Each stop in a route's stop list, and each row of the Bonuses table, has a ⏱ button
  with its minutes: muted on the default, bold orange when the bonus has its own. Clicking it asks for
  the bonus's own minutes (blank goes back to the default); they apply in every route that uses it. A
  route row reads "361.4 mi · 10 h 49 min (1 h 20 min at stops) · 18 stops · 4,215 points", the route summary
  "9 h 29 min driving + 1 h 20 min at 16 stops = 10 h 49 min", plans add stop time the same way, and the
  Selected card's total adds the selection's stop time. `stopMinutesAt()` in `main.ts` mirrors the
  backend rule for the selection, which is not saved yet.
- **Selected card:** the ticked bonuses in order, each with a ⠿ drag handle, its number, name, points,
  ↑ / ↓ and ×, and a points total. Dragging uses pointer events listened for on the window (not pointer
  capture: moving the row in the DOM drops the capture, which first lost every drag). **Create route in
  this order** needs a name and two bonuses; it creates the route with exactly that order and calculates
  the line in it (if GraphHopper fails, the route is kept without a line). **Append** adds the selection
  to the end of a picked route, in order, skipping stops it already has; like any stop change it clears
  the line until recalc (and asks first on an imported track). Both clear the selection, show the
  route on the map, and bring its row into view (`revealRoute()`: opens the Routes section and the
  route's folders, scrolls to the row and flashes it). Without that, a new untagged route landed in the
  last folder far below the Selected card, looked missing, and was created a second time. Nothing in the card ever reorders; optimize stays a separate review on a route.
- **Type or paste a list:** a fold-out box in the Selected card takes bonus codes or POI names in route
  order. Pieces are split on new lines, commas, semicolons, tabs and arrows (→, ->); within a piece the
  words are matched greedily, longest run first, so "Rally HQ Warner Robins ABAC BLHD" on one line finds
  the multi-word name and both codes. A name matches exactly (any case), or else a POI whose name is it
  plus a space and more ("ABAC" finds "ABAC 510"). **Set selection** replaces the selection with the
  matches in the listed order; **Add to selection** appends them. A dialog lists anything not found,
  matching more than one POI, or listed twice (the first is kept); when everything matched the box
  empties. Then Create route in this order makes the route (`matchBonusList()` in `main.ts`).
- **Import card:** one file field for `.gpx` or a rally `.csv`; a `.csv` name goes to `/rally/import`,
  anything else to `/gpx/import`, and a dialog reports what was created vs matched.
- The sidebar is resizable: drag the handle on its right edge (or focus it and use the arrow keys);
  double-click resets to 340px. Width is clamped to 220px minimum and always leaves the map 300px, and
  is remembered in `localStorage` under `route-camp.sidebar-width`. The handle is hidden on narrow screens.
- State is minimal; the server is the source of truth and `refresh()` reloads everything after each
  change. DOM is built with a small `h()` helper that sets user text as text, never HTML.
- **Folders are tags.** The POI and route lists are grouped by tag, client-side (`renderFolders()` in
  `main.ts`). An item with several tags appears in each of its folders; untagged items go in a last
  "Untagged" folder. Each folder header shows the name and count and collapses on click. The old tag
  filter was removed, since folders do the same job.
- **Bulk tagging of POI folders:** each POI folder header has "tag all" (adds a tag, asked for in a
  dialog, to every POI in that folder) and, except on Untagged, "untag all" (removes that folder's tag
  from all its POIs after a confirm; they move to their other folders or to Untagged). Both work while
  the folder is collapsed. Requests go one POI at a time so a big folder doesn't flood SQLite.
- **Select / unselect:** each POI folder header has a "select" button that ticks every POI in the folder
  (appended after the current tick order, in the folder's displayed order). Once all of them are
  ticked it reads "unselect" and unticks them. Works while the folder is collapsed.
- **Delete POIs in a folder:** each POI folder header has "delete", labelled "delete N selected" when
  some of the folder's POIs are ticked (only those are deleted), otherwise "delete all N". It is permanent
  and has no undo (a recreated POI would get a new id and lose its route stops), so the confirm does the
  work: it names the folder and count, says how many routes lose stops (names up to three), and says when
  a POI also has other tags, since it is deleted everywhere. The confirm's button is "Delete". The POIs are
  deleted one request at a time, then the selection drops them and the list reloads (`deleteFolderPois()`).
- **Undo after untag all:** a successful "untag all" shows a bar at the bottom of the page (not a
  modal): `Removed "<tag>" from N POIs.` with **Undo**. Undo re-tags exactly those POI ids, recreating
  the tag by name if it was deleted. The bar goes away after 10 s, on its × button, or when the next
  action runs (`run()` in `main.ts` calls `hideUndo()`). `showUndo()`/`hideUndo()` are in `dialogs.ts`.
- **Scores:** each POI row shows its score and has a "score" button (askText; blank clears it; must be
  a whole number, 0 or more).
- **POI folders start collapsed** on every page load, since there can be well over a hundred POIs;
  opening one lasts for that page view only (`openPoiFolders` in `main.ts`). Their bulk actions work
  while collapsed.
- **Sections collapse:** the POIs, Routes and Plans headers toggle their body. Collapsed sections and
  route folders are remembered in `localStorage` under `route-camp.collapsed` (a list of keys such as
  `section/pois` or `route/<tag>`; `poi/` keys from earlier versions are dropped on load), wrapped in try/catch because storage can be unavailable.
- **POIs:** markers on the map (18 px, white ring; ticked POIs are orange and numbered by their place in the selection); click
  the map to add a POI (asks for a name); tick POIs in a folder (tick order is route order); click a name
  to fly to it; tag the ticked POIs; delete.
- **Map labels:** a "Map labels" control at the top right of the map chooses name (the default,
  since imported names already end in their score), score, both or none, stored in `localStorage` under `route-camp.labels`. Labels are DOM elements inside
  each marker, shown from zoom 9 (`LABEL_MIN_ZOOM`); a white text halo keeps them legible on the basemap.
  Labels do not collide-check: dense clusters overlap at zoom 9–10.
  A MapLibre symbol layer was tried first and stalled the basemap style in the browser pane, so it was
  dropped.
- The old "New route" card (create from ticked POIs, uncalculated) was replaced by the Selected card.
- **Route from a folder:** each POI folder header has "route". It asks for a name and a profile (car or
  fun) and makes a route from the folder's ticked POIs (in tick order) or, if none are ticked, all of its
  POIs. The stops keep that order, and the line is calculated in it straight away. Nothing reorders the
  stops. Fewer than two POIs is refused.
- **Route rows** show distance in miles, driving time, stop count and points ("332.0 mi · 8 h 46 min ·
  16 stops · 3,870 points"); the route summary and plan totals show miles and points too. Points count
  each bonus once (Rally HQ at both ends, or a bonus on two of a plan's routes, isn't doubled). An
  imported GPX track shows "no time" until calculated. Each route has a tick box; ticked routes can be
  tagged or untagged together with the tag field and **Tag selected** / **Untag** under the list.
  Clear map also unticks routes.
- **Route tags** show as chips under the route: × removes one; **+ tag** adds one (or several, comma
  separated) and keeps the others.
- **Adding stops to an existing route:** in the expanded stop list, "add a stop…" appends any POI, and
  **add ticked (N)** appends the ticked POIs in tick order, skipping ones already on the route. Then
  move them with ↑ / ↓ and recalc.
- **Routes:** create from ticked POIs with a profile; per route: **show** / **hide** (a button; clicking
  the name also shows it), expand (▸) to list its stops, calc, optimize, GPX download, tags, add to plan
  (a plan picker), duplicate, delete, table. **table** opens the route table: each stop's number, bonus,
  points, running points total, leg miles, arrival time and minutes stopped, plus the finish time. Arrival is
  the **Start** time (in the table; saved as the `start_minutes` setting) plus the saved leg times and the
  minutes at earlier stops, so it opens without GraphHopper. A route without leg times (not calculated, a GPX
  track, or calculated before legs were saved) shows no arrivals until **calc**. **Print** prints the table alone. **duplicate** asks for a name ("<name> (copy)" by default), then
  shows the copy and scrolls to it, so a route can be changed without losing the original. The shown route's row is highlighted and its button reads "hide". Showing a
  route draws its line, fits the map to it, and numbers its stops on the map in blue (a POI used twice
  shows "2,5"). **Clear map** hides the line, removes the stop numbers and unticks everything without
  deleting anything. Stop markers are 24 px, blue, numbered by position.
- **Moving stops:** drag a stop's ⠿ handle to any place in the list (the sidebar scrolls when the pointer
  nears its top or bottom edge), or click its position number and type the new position. Either saves
  the new order in one request. The Selected card has the same handle and position number. Rows are
  keyed by position, since a POI can be a stop twice (`startDrag()`, `positionButton()`, `moveTo()`).
- **Tag stops:** a route's **tag stops** button asks for a tag (the route's name by default) and adds it
  to every POI on the route, once each. An Undo bar then offers to take it off again, only from the POIs
  that did not already have it.
- **Stops:** in an expanded route each stop has up, down and remove (×). Each change is saved at once and
  clears the line. The route then reads "order changed, recalc" and shows a **recalc** button, which
  calculates the line through the stops in the order the user set. Nothing reorders or recalculates on
  its own; optimize only runs when clicked, through the accept / reject review.
- **Optimize is a review:** optimize asks the preview endpoint and opens a dialog with the current and
  proposed distance and time, Accept or Reject. The proposed line is drawn dashed orange while the dialog is
  open. Reject changes nothing. Accept saves the new order and calculates the line. Under three stops it
  says so and does not open the dialog.
- **Plans:** a plan is one trip made of routes in order, such as Day 1 and Day 2. The Plans section says
  so, and an empty plans list explains it with an example. Create, rename, edit tags, delete; add routes
  from the plan or from a route row, reorder (up/down), remove; totals shown. **show** draws all the
  plan's calculated routes together, each in its own colour (six colours, reused in turn), fits the map,
  and lists the routes with a colour swatch in the Routes summary; a route with no line is listed as not
  calculated.
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
`CORS_ORIGINS`, `SHAPING_SPACING_KM` (default 10; 0 turns shaping points off) and `MAX_ROUTE_POINTS`
(default 50).

```bash
docker compose up -d --build                                              # production build
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build # Vite dev server, hot reload
docker compose exec backend python -m pytest -q                           # tests
```

Data lives in `./data` (git-ignored): `osm/` (extract), `graph-cache/` (GraphHopper), `db/` (SQLite).

## 8. Tests

`backend/tests`, 59 tests, none need GraphHopper (it is faked): models and cascades, geometry
(haversine, simplification), GPX parse/build round trip, optimize, the REST API, plans API (totals,
reorder, tags), track import and re-import de-duplication, shaping-point spacing, budget and round trip, and the
rally CSV (parsing, header and bad lines, creating, matching "CODE" and "CODE points" names, no
duplicates on re-import, names/tags/notes kept), and stop time (the default and changing it, a POI's own
minutes, first and last stops, plan totals). There are no frontend tests; UI checks were
done by hand in a browser.

## 9. Known gaps and next steps

- Scores: the name rule is "a space and 1 to 9 digits at the end" (so "Route 66" would score 66). The
  backfill is a manual command (`python -m app.backfill_scores`), not automatic. UI-created POIs get no
  score unless one is typed in. Only the score column changes; GPX export is unchanged.
- Labels: no collision handling, so dense clusters overlap at zoom 9–10. A symbol layer with collision
  would fix that, but it stalled the basemap style in the browser pane; the cause is unknown.
- Garmin shaping points: ride a route exported with them to confirm the zūmo keeps to the planned
  roads, and confirm the device's limit on route points (`max_route_points`).
- The "fun" profile only re-weights road classes. A curvature-based model would be closer to Kurviger.
- No login, single user. Before hosting publicly: add auth, move to Postgres, add Alembic, and pick a
  tile source with terms suitable for the traffic.
- Sync SQLAlchemy runs inside FastAPI handlers (fine for one user); GPX import reads the whole file into
  memory.
- No offline tiles (PMTiles would allow it), no POI editing UI beyond create/delete, no bulk actions.
- Optimize keeps the first stop fixed and has no return leg, time windows or scoring.
- Accept saves the new order before it calculates the line. If GraphHopper fails at that second step the
  order is kept and the route has no line; calc again to retry.
- Ordering the POIs of a tag folder as a whole (a "sequence" the folder keeps) is not built; order is
  set in the Selected card or on a route.
- The plan view has no map of each plan's stops, and it draws only routes that have a line.
- Rally features not ported from rally-route-finder yet: choosing the best set of bonuses within a time
  budget (its solvers), combos, bonus hours (open/close times), late penalties, slow zones, and its login.
  The Bonuses table only selects and orders by hand.
- Rally CSV: POIs it creates are named by the code alone ("ABAC"), while GPX-imported rally POIs end in
  their points ("ABAC 510"); both match on re-import. The file's combo and hours columns are ignored.
- The selection is in memory: a page reload clears it.

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
  added plans UI, track import, de-dup and the nginx build; then in-page dialogs and Clear map. Later
  the rally-route-finder look, the Bonuses table, the ordered Selected card and rally CSV import.
  Then time at each stop: a default for all stops and a bonus's own minutes.
