import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { askConfirm, askText, showMessage } from "./dialogs";
import { api, type ImportSummary, type Plan, type POI, type Profile, type Route, type Tag } from "./api";

// Minimal app state. The server is the source of truth; refresh() reloads everything after each change.
const state = {
  pois: [] as POI[],
  routes: [] as Route[],
  plans: [] as Plan[],
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
  void showMessage(message);
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

const formatKm = (metres: number): string => `${(metres / 1000).toFixed(1)} km`;

function routeSummary(route: Route): string {
  if (route.distance_m == null || !route.geometry) return `${route.name}: not calculated yet.`;
  const origin = route.geometry_source === "imported" ? "GPX track" : route.profile;
  const time = route.time_s == null ? "no time" : formatDuration(route.time_s);
  return `${route.name} (${origin}): ${formatKm(route.distance_m)}, ${time}`;
}

function planTotals(plan: Plan): string {
  if (plan.routes_total === 0) return "no routes yet";
  const parts = [formatKm(plan.distance_m)];
  if (plan.routes_with_time === 0) {
    parts.push("no time");
  } else {
    parts.push(formatDuration(plan.time_s) + (plan.routes_with_time < plan.routes_total ? " (partial)" : ""));
  }
  const missing = plan.routes_total - plan.routes_with_distance;
  if (missing > 0) parts.push(`${missing} not calculated`);
  return parts.join(" · ");
}

function importMessage(summary: ImportSummary): string {
  const names = (status: ImportSummary["routes"][number]["status"]) =>
    summary.routes
      .filter((r) => r.status === status)
      .map((r) => (r.kind === "track" ? `${r.name} (track)` : r.name));
  const created = names("created");
  const matched = names("matched");
  return [
    `POIs: ${summary.pois_created} new, ${summary.pois_matched} already there.`,
    `Routes: ${summary.routes_created} new${created.length ? ` (${created.join(", ")})` : ""}, ` +
      `${summary.routes_matched} already imported${matched.length ? ` (${matched.join(", ")})` : ""}.`,
  ].join("\n");
}

// Calculating or optimizing over an imported GPX track replaces it, so ask first.
async function confirmReplaceImported(route: Route, action: string): Promise<boolean> {
  if (route.geometry_source !== "imported") return true;
  return askConfirm(`"${route.name}" has an imported GPX track. ${action} replaces that track. Continue?`);
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
    const name = (await askText("Name for the new POI?"))?.trim();
    if (!name) return;
    await api.createPoi({ name, lat: event.lngLat.lat, lon: event.lngLat.lng });
    await refresh();
  }),
);

function showRoute(route: Route): void {
  state.shownRouteId = route.id;
  const summary = $("route-summary");
  summary.textContent = routeSummary(route);
  const source = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  if (!source) {
    pendingRoute = route; // drawn by the style.load handler
    return;
  }
  pendingRoute = null;
  if (!route.geometry || route.geometry.length === 0) {
    source.setData(emptyLine);
    return;
  }
  source.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: route.geometry },
  });
  const [first, ...rest] = route.geometry;
  const bounds = rest.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(first, first));
  map.fitBounds(bounds, { padding: 60 });
}

function clearShownRoute(): void {
  state.shownRouteId = null;
  pendingRoute = null;
  $("route-summary").textContent = "";
  map.getSource<maplibregl.GeoJSONSource>("route")?.setData(emptyLine);
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
              if (!(await askConfirm(`Delete POI "${poi.name}"? Routes that use it will lose that stop.`, "Delete"))) return;
              await api.deletePoi(poi.id);
              state.selected = state.selected.filter((id) => id !== poi.id);
              await refresh();
            }),
        }, "delete"),
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

async function calculate(route: Route): Promise<void> {
  if (!(await confirmReplaceImported(route, "Calculating"))) return;
  const updated = await api.calculateRoute(route.id, route.geometry_source === "imported");
  await refresh();
  showRoute(updated);
}

async function optimize(route: Route): Promise<void> {
  if (!(await confirmReplaceImported(route, "Optimizing"))) return;
  const { source } = await api.optimizeRoute(route.id, route.geometry_source === "imported");
  await refresh();
  notify(
    source === "none"
      ? "Need at least three stops to reorder."
      : `Stops reordered using ${source} travel times. Calculate the route again to refresh the line.`,
  );
}

function renderRoutes(): void {
  $("route-list").replaceChildren(
    ...state.routes.map((route) =>
      h(
        "li",
        { className: "item" },
        h(
          "span",
          { className: "name", title: route.name, onclick: () => showRoute(route) },
          `${route.name} (${route.geometry_source === "imported" ? "track" : route.profile})`,
        ),
        h(
          "span",
          { className: "meta" },
          route.distance_m == null ? `${route.poi_ids.length} stops` : formatKm(route.distance_m),
        ),
        h("button", {
          title: "Calculate with GraphHopper",
          onclick: () => run(() => calculate(route)),
        }, "calc"),
        h("button", {
          title: "Reorder stops for shortest time",
          onclick: () => run(() => optimize(route)),
        }, "optimize"),
        h("a", { href: api.routeGpxUrl(route.id), download: "", title: "Export GPX" }, "GPX"),
        h("button", {
          title: "Delete route",
          onclick: () =>
            run(async () => {
              if (!(await askConfirm(`Delete route "${route.name}"?`, "Delete"))) return;
              await api.deleteRoute(route.id);
              if (state.shownRouteId === route.id) clearShownRoute();
              await refresh();
            }),
        }, "delete"),
      ),
    ),
  );
}

// --- Sidebar: plans ---------------------------------------------------------

const routeName = (id: number): string => state.routes.find((r) => r.id === id)?.name ?? `route ${id}`;

function setPlanRoutes(plan: Plan, routeIds: number[]): Promise<void> {
  return run(async () => {
    await api.updatePlan(plan.id, { route_ids: routeIds });
    await refresh();
  });
}

function addRouteRow(plan: Plan): HTMLElement {
  const available = state.routes.filter((r) => !plan.route_ids.includes(r.id));
  const select = h(
    "select",
    {},
    h("option", { value: "" }, available.length ? "add a route…" : "no routes to add"),
    ...available.map((r) => h("option", { value: String(r.id) }, r.name)),
  );
  const add = h("button", {
    onclick: () => {
      const id = Number(select.value);
      if (id) void setPlanRoutes(plan, [...plan.route_ids, id]);
    },
  }, "add");
  return h("div", { className: "row" }, select, add);
}

function renderPlans(): void {
  $("plan-list").replaceChildren(
    ...state.plans.map((plan) =>
      h(
        "li",
        { className: "plan" },
        h(
          "div",
          { className: "plan-head" },
          h("span", { className: "name", title: plan.name }, plan.name),
          h("button", {
            title: "Rename plan",
            onclick: () =>
              run(async () => {
                const name = (await askText("Plan name?", plan.name))?.trim();
                if (!name) return;
                await api.updatePlan(plan.id, { name });
                await refresh();
              }),
          }, "rename"),
          h("button", {
            title: "Edit tags",
            onclick: () =>
              run(async () => {
                const input = await askText("Tags, comma separated?", plan.tags.join(", "));
                if (input === null) return;
                const tags = input.split(",").map((t) => t.trim()).filter(Boolean);
                await api.updatePlan(plan.id, { tags });
                await refresh();
              }),
          }, "tags"),
          h("button", {
            title: "Delete plan",
            onclick: () =>
              run(async () => {
                if (!(await askConfirm(`Delete plan "${plan.name}"? Its routes are kept.`, "Delete"))) return;
                await api.deletePlan(plan.id);
                await refresh();
              }),
          }, "delete"),
        ),
        h(
          "div",
          { className: "meta" },
          planTotals(plan) + (plan.tags.length ? ` · ${plan.tags.join(", ")}` : ""),
        ),
        h(
          "ol",
          { className: "plan-routes" },
          ...plan.route_ids.map((id, index) => {
            const move = (step: number) => {
              const ids = [...plan.route_ids];
              [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
              return setPlanRoutes(plan, ids);
            };
            return h(
              "li",
              { className: "item" },
              h("span", { className: "name", title: routeName(id) }, routeName(id)),
              h("button", { title: "Move up", disabled: index === 0, onclick: () => move(-1) }, "↑"),
              h("button", {
                title: "Move down",
                disabled: index === plan.route_ids.length - 1,
                onclick: () => move(1),
              }, "↓"),
              h("button", {
                title: "Remove from plan",
                onclick: () => setPlanRoutes(plan, plan.route_ids.filter((_, i) => i !== index)),
              }, "remove"),
            );
          }),
        ),
        addRouteRow(plan),
      ),
    ),
  );
}

// --- Data loading -----------------------------------------------------------

async function refresh(): Promise<void> {
  const tag = $<HTMLSelectElement>("tag-filter").value;
  const [pois, routes, plans, tags] = await Promise.all([
    api.listPois(tag),
    api.listRoutes(),
    api.listPlans(tag),
    api.listTags(),
  ]);
  state.pois = pois;
  state.routes = routes;
  state.plans = plans;
  renderTagFilter(tags);
  renderPois();
  renderRoutes();
  renderPlans();
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

// Hides the drawn route and unticks POIs; nothing is deleted.
$("map-clear").onclick = () => {
  clearShownRoute();
  state.selected = [];
  renderPois();
  renderMarkers();
};

$("plan-create").onclick = () =>
  run(async () => {
    const input = $<HTMLInputElement>("plan-name");
    const name = input.value.trim();
    if (!name) {
      notify("Name the plan first.");
      return;
    }
    await api.createPlan({ name });
    input.value = "";
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
    notify(importMessage(summary));
    await refresh();
  });

await run(refresh);
