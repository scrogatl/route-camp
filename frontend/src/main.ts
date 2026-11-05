import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { api, type Profile, type POI, type Route, type Tag } from "./api";

// Minimal app state. The server is the source of truth; refresh() reloads everything after each change.
const state = {
  pois: [] as POI[],
  routes: [] as Route[],
  selected: [] as number[], // POI ids in the order they were ticked (= route order)
  shownRouteId: null as number | null,
};

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// Small DOM helper so user-supplied names are set as text, never as HTML.
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value as EventListener);
    } else {
      Reflect.set(node, key, value);
    }
  }
  node.append(...children);
  return node;
}

function notify(message: string): void {
  window.alert(message);
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err));
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

const emptyLine = { type: "FeatureCollection", features: [] } as { type: "FeatureCollection"; features: never[] };

// --- Map --------------------------------------------------------------------

const config = await api.config();
const map = new maplibregl.Map({
  container: "map",
  style: config.map_style_url,
  center: [-83.6, 32.9], // Georgia, USA; the default region
  zoom: 6,
});
// The route layer is added once the style is ready. Not awaited, so a slow or failing basemap
// style never blocks the sidebar and markers.
let pendingRoute: Route | null = null;

map.on("style.load", () => {
  map.addSource("route", { type: "geojson", data: emptyLine });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#d9480f", "line-width": 4 },
  });
  if (pendingRoute) showRoute(pendingRoute);
});

let markers: maplibregl.Marker[] = [];

function renderMarkers(): void {
  markers.forEach((marker) => marker.remove());
  markers = state.pois.map((poi) => {
    const element = h("div", {
      className: state.selected.includes(poi.id) ? "marker selected" : "marker",
      title: poi.name,
      onclick: (event: Event) => {
        event.stopPropagation();
        toggleSelected(poi.id);
      },
    });
    return new maplibregl.Marker({ element }).setLngLat([poi.lon, poi.lat]).addTo(map);
  });
}

map.on("click", (event) =>
  run(async () => {
    const name = window.prompt("Name for the new POI?")?.trim();
    if (!name) return;
    await api.createPoi({ name, lat: event.lngLat.lat, lon: event.lngLat.lng });
    await refresh();
  }),
);

function showRoute(route: Route): void {
  state.shownRouteId = route.id;
  const summary = $("route-summary");
  const source = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  if (!source) {
    pendingRoute = route; // drawn by the style.load handler
    summary.textContent = `${route.name}: map is still loading.`;
    return;
  }
  pendingRoute = null;
  if (!route.geometry || route.geometry.length === 0 || route.distance_m == null || route.time_s == null) {
    source.setData(emptyLine);
    summary.textContent = `${route.name}: not calculated yet.`;
    return;
  }
  source.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: route.geometry },
  });
  const [first, ...rest] = route.geometry;
  const bounds = rest.reduce(
    (box, point) => box.extend(point),
    new maplibregl.LngLatBounds(first, first),
  );
  map.fitBounds(bounds, { padding: 60 });
  summary.textContent = `${route.name} (${route.profile}): ${(route.distance_m / 1000).toFixed(1)} km, ${formatDuration(route.time_s)}`;
}

// --- Sidebar: POIs ----------------------------------------------------------

function toggleSelected(poiId: number): void {
  state.selected = state.selected.includes(poiId)
    ? state.selected.filter((id) => id !== poiId)
    : [...state.selected, poiId];
  renderPois();
  renderMarkers();
}

function renderPois(): void {
  $("poi-list").replaceChildren(
    ...state.pois.map((poi) =>
      h(
        "li",
        { className: "item" },
        h("input", {
          type: "checkbox",
          checked: state.selected.includes(poi.id),
          onchange: () => toggleSelected(poi.id),
        }),
        h(
          "span",
          {
            className: "name",
            title: poi.name,
            onclick: () => map.flyTo({ center: [poi.lon, poi.lat], zoom: 12 }),
          },
          poi.name,
        ),
        h("span", { className: "meta" }, poi.tags.join(", ")),
        h("button", {
          title: "Delete POI",
          onclick: () =>
            run(async () => {
              if (!window.confirm(`Delete POI "${poi.name}"? Routes that use it will lose that stop.`)) return;
              await api.deletePoi(poi.id);
              state.selected = state.selected.filter((id) => id !== poi.id);
              await refresh();
            }),
        }, "×"),
      ),
    ),
  );
}

function renderTagFilter(tags: Tag[]): void {
  const select = $<HTMLSelectElement>("tag-filter");
  const current = select.value;
  select.replaceChildren(
    h("option", { value: "" }, "All"),
    ...tags.map((tag) => h("option", { value: tag.name }, tag.name)),
  );
  select.value = current;
}

// --- Sidebar: routes --------------------------------------------------------

function renderRoutes(): void {
  $("route-list").replaceChildren(
    ...state.routes.map((route) =>
      h(
        "li",
        { className: "item" },
        h(
          "span",
          { className: "name", title: route.name, onclick: () => showRoute(route) },
          `${route.name} (${route.profile})`,
        ),
        h(
          "span",
          { className: "meta" },
          route.distance_m == null || route.time_s == null
            ? `${route.poi_ids.length} stops`
            : `${(route.distance_m / 1000).toFixed(1)} km`,
        ),
        h("button", {
          title: "Calculate with GraphHopper",
          onclick: () =>
            run(async () => {
              const updated = await api.calculateRoute(route.id);
              await refresh();
              showRoute(updated);
            }),
        }, "calc"),
        h("button", {
          title: "Reorder stops for shortest time",
          onclick: () =>
            run(async () => {
              const { source } = await api.optimizeRoute(route.id);
              await refresh();
              const message =
                source === "none"
                  ? "Need at least three stops to reorder."
                  : `Stops reordered using ${source} travel times. Calculate the route again to refresh the line.`;
              notify(message);
            }),
        }, "optimize"),
        h("a", { href: api.routeGpxUrl(route.id), download: "", title: "Export GPX" }, "GPX"),
        h("button", {
          title: "Delete route",
          onclick: () =>
            run(async () => {
              if (!window.confirm(`Delete route "${route.name}"?`)) return;
              await api.deleteRoute(route.id);
              if (state.shownRouteId === route.id) {
                state.shownRouteId = null;
                showRoute({ ...route, geometry: null, distance_m: null, time_s: null });
              }
              await refresh();
            }),
        }, "×"),
      ),
    ),
  );
}

// --- Data loading -----------------------------------------------------------

async function refresh(): Promise<void> {
  const tag = $<HTMLSelectElement>("tag-filter").value;
  const [pois, routes, tags] = await Promise.all([api.listPois(tag), api.listRoutes(), api.listTags()]);
  state.pois = pois;
  state.routes = routes;
  renderTagFilter(tags);
  renderPois();
  renderRoutes();
  renderMarkers();
}

// --- Wire up controls -------------------------------------------------------

$<HTMLSelectElement>("tag-filter").onchange = () => run(refresh);

$("tag-selected").onclick = () =>
  run(async () => {
    const input = $<HTMLInputElement>("tag-input");
    const name = input.value.trim();
    if (!name || state.selected.length === 0) {
      notify("Type a tag name and tick at least one POI.");
      return;
    }
    const tag = await api.createTag(name);
    await Promise.all(state.selected.map((id) => api.tagItem(tag.id, "poi", id)));
    input.value = "";
    await refresh();
  });

$("route-create").onclick = () =>
  run(async () => {
    const name = $<HTMLInputElement>("route-name").value.trim();
    if (!name || state.selected.length < 2) {
      notify("Name the route and tick at least two POIs.");
      return;
    }
    const profile = $<HTMLSelectElement>("route-profile").value as Profile;
    await api.createRoute({ name, profile, poi_ids: [...state.selected] });
    $<HTMLInputElement>("route-name").value = "";
    state.selected = [];
    await refresh();
  });

$("gpx-import").onclick = () =>
  run(async () => {
    const input = $<HTMLInputElement>("gpx-file");
    const file = input.files?.[0];
    if (!file) {
      notify("Choose a .gpx file first.");
      return;
    }
    const summary = await api.importGpx(file);
    input.value = "";
    notify(
      `Imported ${summary.pois_created} new POIs (${summary.pois_matched} already existed) and ${summary.routes_created} routes.` +
        (summary.tracks_skipped ? ` ${summary.tracks_skipped} track(s) were skipped.` : ""),
    );
    await refresh();
  });

await run(refresh);
