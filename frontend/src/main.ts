import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { askConfirm, askText, hideUndo, showMessage, showUndo } from "./dialogs";
import { api, type ImportSummary, type Plan, type POI, type Profile, type Route } from "./api";

// Minimal app state. The server is the source of truth; refresh() reloads everything after each change.
const state = {
  pois: [] as POI[],
  routes: [] as Route[],
  plans: [] as Plan[],
  selected: [] as number[], // POI ids in the order they were ticked (= route order)
  shownRouteId: null as number | null,
};

const expandedRoutes = new Set<number>(); // routes whose stops are listed in the sidebar

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
    } else if (key.startsWith("aria-")) {
      node.setAttribute(key, String(value));
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
  hideUndo(); // any new action ends the chance to undo the previous one
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

// Asks for comma-separated tags; null when cancelled.
async function askTags(current: string[]): Promise<string[] | null> {
  const input = await askText("Tags, comma separated?", current.join(", "));
  if (input === null) return null;
  return input.split(",").map((t) => t.trim()).filter(Boolean);
}

const emptyLine = { type: "FeatureCollection", features: [] } as { type: "FeatureCollection"; features: never[] };

// --- Collapsed state --------------------------------------------------------

// Collapsed sections and folders are remembered per browser. Storage can be unavailable (private
// window, blocked site data), in which case the state simply lasts for this page view.
const COLLAPSED_KEY = "route-camp.collapsed";

function loadCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

const collapsed = new Set<string>(loadCollapsed());

function setCollapsed(key: string, value: boolean): void {
  if (value) collapsed.add(key);
  else collapsed.delete(key);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Not stored; the change still applies to this page view.
  }
}

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
  map.addSource("pois", { type: "geojson", data: emptyLine });
  map.addLayer({
    id: "poi-labels",
    type: "symbol",
    source: "pois",
    minzoom: 7,
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"], // the basemap's glyph server has Noto Sans, not MapLibre's default
      "text-size": 12,
      "text-anchor": "top",
      "text-offset": [0, 1.3],
      "text-max-width": 14,
    },
    paint: {
      "text-color": "#1d1d1f",
      "text-halo-color": "#ffffff",
      "text-halo-width": 2,
    },
  });
  renderLabels();
  if (pendingRoute) showRoute(pendingRoute);
});

let markers: maplibregl.Marker[] = [];

// Map labels are a symbol layer, not DOM labels: MapLibre's collision detection hides the ones that
// would overlap, so the 138-odd labels stay readable at state zoom. The layer only shows from zoom 7.
type LabelMode = "both" | "name" | "score" | "none";
const LABEL_KEY = "route-camp.labels";
const LABEL_MODES: LabelMode[] = ["both", "name", "score", "none"];

function loadLabelMode(): LabelMode {
  try {
    const stored = localStorage.getItem(LABEL_KEY);
    return LABEL_MODES.find((mode) => mode === stored) ?? "both";
  } catch {
    return "both";
  }
}

let labelMode = loadLabelMode();

function labelFor(poi: POI): string {
  const showName = labelMode === "name" || labelMode === "both";
  const showScore = (labelMode === "score" || labelMode === "both") && poi.score != null;
  if (showName && showScore) return `${poi.name} · ${poi.score}`;
  if (showName) return poi.name;
  return showScore ? String(poi.score) : "";
}

function renderLabels(): void {
  const source = map.getSource<maplibregl.GeoJSONSource>("pois");
  if (!source) return; // the style is still loading; style.load draws them
  const features = state.pois
    .map((poi) => ({
      type: "Feature" as const,
      properties: { label: labelFor(poi) },
      geometry: { type: "Point" as const, coordinates: [poi.lon, poi.lat] },
    }))
    .filter((feature) => feature.properties.label !== "");
  source.setData({ type: "FeatureCollection", features });
}

// Stops of the route on the map, numbered by position ("2" or "2,5" when the POI appears twice).
function stopLabels(): Map<number, string> {
  const positions = new Map<number, number[]>();
  const route = state.routes.find((r) => r.id === state.shownRouteId);
  route?.poi_ids.forEach((poiId, index) => positions.set(poiId, [...(positions.get(poiId) ?? []), index + 1]));
  return new Map([...positions].map(([poiId, numbers]) => [poiId, numbers.join(",")]));
}

function renderMarkers(): void {
  markers.forEach((marker) => marker.remove());
  const stops = stopLabels();
  markers = state.pois.map((poi) => {
    const stop = stops.get(poi.id);
    const classes = ["marker"];
    if (state.selected.includes(poi.id)) classes.push("selected");
    if (stop) classes.push("stop");
    const element = h(
      "div",
      {
        className: classes.join(" "),
        title: stop ? `Stop ${stop}: ${poi.name}` : poi.name,
        onclick: (event: Event) => {
          event.stopPropagation();
          toggleSelected(poi.id);
        },
      },
      stop ?? "",
    );
    return new maplibregl.Marker({ element }).setLngLat([poi.lon, poi.lat]).addTo(map);
  });
  renderLabels();
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
  renderMarkers();
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
  renderMarkers();
}

// --- Folders ----------------------------------------------------------------

const UNTAGGED = "Untagged";

// Folders are tags. An item with several tags appears in each of its folders; untagged items go in
// a last "Untagged" folder. `prefix` keeps the collapsed keys of POI and route folders apart.
// `folderActions` adds buttons beside a folder's header; tag is "" for the Untagged folder.
function renderFolders<T extends { id: number; name: string; tags: string[] }>(
  container: HTMLElement,
  prefix: string,
  items: T[],
  renderItem: (item: T) => HTMLElement,
  rerender: () => void,
  folderActions: (tag: string, list: T[]) => HTMLElement[] = () => [],
): void {
  const folders = new Map<string, T[]>();
  for (const item of items) {
    for (const tag of item.tags.length ? item.tags : [""]) {
      folders.set(tag, [...(folders.get(tag) ?? []), item]);
    }
  }
  const tags = [...folders.keys()].filter(Boolean).sort();
  if (folders.has("")) tags.push("");

  container.replaceChildren(
    ...tags.map((tag) => {
      const key = `${prefix}/${tag}`;
      const isCollapsed = collapsed.has(key);
      const list = (folders.get(tag) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      return h(
        "li",
        { className: "folder" },
        h(
          "div",
          { className: "folder-row" },
          h(
            "button",
            {
              className: "folder-head",
              "aria-expanded": !isCollapsed,
              onclick: () => {
                setCollapsed(key, !isCollapsed);
                rerender();
              },
            },
            `${tag || UNTAGGED} (${list.length})`,
          ),
          ...folderActions(tag, list),
        ),
        ...(isCollapsed ? [] : [h("ul", { className: "folder-items" }, ...list.map(renderItem))]),
      );
    }),
  );
}

// --- Sidebar: POIs ----------------------------------------------------------

function toggleSelected(poiId: number): void {
  state.selected = state.selected.includes(poiId)
    ? state.selected.filter((id) => id !== poiId)
    : [...state.selected, poiId];
  renderPois();
  renderMarkers();
}

// Sets or clears a POI's score. Blank clears it; anything else must be a whole number of zero or more.
async function editScore(poi: POI): Promise<void> {
  const input = await askText(`Score for "${poi.name}" (blank clears it)?`, poi.score == null ? "" : String(poi.score));
  if (input === null) return;
  const text = input.trim();
  if (text !== "" && !/^\d+$/.test(text)) {
    notify("A score is a whole number, 0 or more.");
    return;
  }
  await api.updatePoi(poi.id, { score: text === "" ? null : Number(text) });
  await refresh();
}

function renderPoiItem(poi: POI): HTMLElement {
  return h(
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
    h("span", { className: "meta", title: "Score" }, poi.score == null ? "" : String(poi.score)),
    h("button", { title: "Set the score", onclick: () => run(() => editScore(poi)) }, "score"),
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
  );
}

// One request per POI, in sequence, so a large folder doesn't flood the backend (SQLite) at once.
async function forEachPoi(pois: POI[], action: (poi: POI) => Promise<void>): Promise<void> {
  for (const poi of pois) await action(poi);
}

// "tag all" adds a tag to every POI in the folder; "untag all" takes the folder's own tag off them
// (they move to their other folders, or to Untagged). Works whether the folder is open or collapsed.
function poiFolderActions(tag: string, pois: POI[]): HTMLElement[] {
  const ids = pois.map((poi) => poi.id);
  const allTicked = ids.every((id) => state.selected.includes(id));
  // Ticks the folder's POIs in its displayed order, after any already ticked; unticks them all when every one is ticked.
  const selectAll = h("button", {
    className: "folder-action",
    title: allTicked ? "Untick every POI in this folder" : "Tick every POI in this folder",
    onclick: () => {
      state.selected = allTicked
        ? state.selected.filter((id) => !ids.includes(id))
        : [...state.selected, ...ids.filter((id) => !state.selected.includes(id))];
      renderPois();
      renderMarkers();
    },
  }, allTicked ? "unselect" : "select");
  const tagAll = h("button", {
    className: "folder-action",
    title: `Add a tag to all ${pois.length} POIs in this folder`,
    onclick: () =>
      run(async () => {
        const name = (await askText(`Tag all ${pois.length} POIs in "${tag || UNTAGGED}" with:`))?.trim();
        if (!name) return;
        const created = await api.createTag(name);
        await forEachPoi(pois, (poi) => api.tagItem(created.id, "poi", poi.id));
        await refresh();
      }),
  }, "tag all");
  if (!tag) return [selectAll, tagAll];
  const untagAll = h("button", {
    className: "folder-action",
    title: `Remove the "${tag}" tag from all ${pois.length} POIs`,
    onclick: () =>
      run(async () => {
        const message = `Remove the "${tag}" tag from all ${pois.length} POIs? The POIs are kept.`;
        if (!(await askConfirm(message, "Untag all"))) return;
        const found = (await api.listTags()).find((t) => t.name === tag);
        if (!found) return;
        const ids = pois.map((poi) => poi.id);
        await forEachPoi(pois, (poi) => api.untagItem(found.id, "poi", poi.id));
        await refresh();
        showUndo(`Removed "${tag}" from ${ids.length} POIs.`, () => run(() => retagPois(tag, ids)));
      }),
  }, "untag all");
  return [selectAll, tagAll, untagAll];
}

// Puts a tag back on exactly these POIs (those still in the library), recreating the tag if it was deleted.
async function retagPois(tagName: string, ids: number[]): Promise<void> {
  const tag = await api.createTag(tagName);
  const present = new Set(state.pois.map((poi) => poi.id));
  for (const id of ids) {
    if (present.has(id)) await api.tagItem(tag.id, "poi", id);
  }
  await refresh();
}

function renderPois(): void {
  renderFolders($("poi-list"), "poi", state.pois, renderPoiItem, renderPois, poiFolderActions);
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

// The stops of a route, in order. Clicking one flies the map to it.
function renderStops(route: Route): HTMLElement {
  return h(
    "ol",
    { className: "route-stops" },
    ...route.poi_ids.map((poiId, index) => {
      const poi = state.pois.find((p) => p.id === poiId);
      return h(
        "li",
        {},
        h("span", { className: "stop-number" }, String(index + 1)),
        poi
          ? h("span", {
              className: "name",
              title: poi.name,
              onclick: () => map.flyTo({ center: [poi.lon, poi.lat], zoom: 12 }),
            }, poi.name)
          : h("span", { className: "name meta" }, "(deleted POI)"),
      );
    }),
  );
}

function renderRouteItem(route: Route): HTMLElement {
  const expanded = expandedRoutes.has(route.id);
  const toggleStops = () => {
    if (expanded) expandedRoutes.delete(route.id);
    else expandedRoutes.add(route.id);
    renderRoutes();
  };
  return h(
    "li",
    { className: "route" },
    h(
      "div",
      { className: "route-head" },
      h("button", {
        className: "expand",
        title: expanded ? "Hide stops" : "Show stops",
        "aria-expanded": expanded,
        onclick: toggleStops,
      }),
      h(
        "span",
        { className: "name", title: route.name, onclick: () => showRoute(route) },
        `${route.name} (${route.geometry_source === "imported" ? "track" : route.profile})`,
      ),
    ),
    h(
      "div",
      { className: "route-actions" },
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
        title: "Edit tags",
        onclick: () =>
          run(async () => {
            const tags = await askTags(route.tags);
            if (tags === null) return;
            await api.updateRoute(route.id, { tags });
            await refresh();
          }),
      }, "tags"),
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
    ...(expanded ? [renderStops(route)] : []),
  );
}

function renderRoutes(): void {
  renderFolders($("route-list"), "route", state.routes, renderRouteItem, renderRoutes);
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
                const tags = await askTags(plan.tags);
                if (tags === null) return;
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
  const [pois, routes, plans] = await Promise.all([api.listPois(), api.listRoutes(), api.listPlans()]);
  state.pois = pois;
  state.routes = routes;
  state.plans = plans;
  renderPois();
  renderRoutes();
  renderPlans();
  renderMarkers();
}

// --- Wire up controls -------------------------------------------------------

const labelSelect = $<HTMLSelectElement>("label-mode");
labelSelect.value = labelMode;
labelSelect.onchange = () => {
  labelMode = LABEL_MODES.find((mode) => mode === labelSelect.value) ?? "both";
  try {
    localStorage.setItem(LABEL_KEY, labelMode);
  } catch {
    // Not stored; the choice still applies to this page view.
  }
  renderLabels();
};

// Each section header toggles its body; the state is remembered like the folders.
for (const toggle of document.querySelectorAll<HTMLButtonElement>(".section-toggle")) {
  const section = toggle.dataset.section ?? "";
  const key = `section/${section}`;
  const body = $(`${section}-body`);
  const apply = () => {
    const isCollapsed = collapsed.has(key);
    toggle.setAttribute("aria-expanded", String(!isCollapsed));
    body.hidden = isCollapsed;
  };
  toggle.onclick = () => {
    setCollapsed(key, !collapsed.has(key));
    apply();
  };
  apply();
}

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
