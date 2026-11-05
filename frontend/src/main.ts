import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { askConfirm, askDecision, askText, hideUndo, showMessage, showUndo } from "./dialogs";
import {
  api,
  type ImportSummary,
  type LonLat,
  type OptimizePreview,
  type OrderSummary,
  type Plan,
  type POI,
  type Profile,
  type Route,
} from "./api";

// Minimal app state. The server is the source of truth; refresh() reloads everything after each change.
const state = {
  pois: [] as POI[],
  routes: [] as Route[],
  plans: [] as Plan[],
  selected: [] as number[], // POI ids in the order they were ticked (= route order)
  shownRouteId: null as number | null,
  shownPlanId: null as number | null,
};

const expandedRoutes = new Set<number>(); // routes whose stops are listed in the sidebar
// Routes whose stops were reordered since their line was last calculated. Kept in memory only; after a
// reload a route without a line simply reads "not calculated".
const staleRoutes = new Set<number>();

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

function orderTotals(order: OrderSummary): string {
  if (order.distance_m == null) return "no distance (GraphHopper unavailable)";
  const time = order.time_s == null ? "no time" : formatDuration(order.time_s);
  return `${formatKm(order.distance_m)}, ${time}`;
}

// Replaces the route summary under the Routes section (text, or nodes for the plan legend).
function setSummary(...content: (Node | string)[]): void {
  $("route-summary").replaceChildren(...content);
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
  map.addSource("preview", { type: "geojson", data: emptyLine });
  map.addLayer({
    id: "preview-line",
    type: "line",
    source: "preview",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#1971c2", "line-width": 4, "line-dasharray": [2, 2] },
  });
  map.addSource("plan", { type: "geojson", data: emptyLine });
  map.addLayer({
    id: "plan-lines",
    type: "line",
    source: "plan",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.85 },
  });
  if (pendingRoute) showRoute(pendingRoute);
});

let markers: maplibregl.Marker[] = [];

// POI labels are DOM elements shown only from LABEL_MIN_ZOOM, so the state-wide view stays uncluttered.
// (A MapLibre symbol layer was tried first; in the browser pane it stalled the basemap style.)
type LabelMode = "both" | "name" | "score" | "none";
const LABEL_KEY = "route-camp.labels";
const LABEL_MODES: LabelMode[] = ["both", "name", "score", "none"];
const LABEL_MIN_ZOOM = 9;
// Name only by default: imported rally POI names already end in their score ("TALU 669").
const DEFAULT_LABEL_MODE: LabelMode = "name";

function loadLabelMode(): LabelMode {
  try {
    const stored = localStorage.getItem(LABEL_KEY);
    return LABEL_MODES.find((mode) => mode === stored) ?? DEFAULT_LABEL_MODE;
  } catch {
    return DEFAULT_LABEL_MODE;
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

function updateLabelVisibility(): void {
  $("map").classList.toggle("show-labels", map.getZoom() >= LABEL_MIN_ZOOM);
}
map.on("zoom", updateLabelVisibility);
updateLabelVisibility();

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
    const label = labelFor(poi);
    const element = h(
      "div",
      { className: "poi-pin" },
      h(
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
      ),
      ...(label ? [h("span", { className: "poi-label" }, label)] : []),
    );
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

// Frames the map on a line. Does nothing for an empty line.
function fitTo(points: LonLat[]): void {
  if (points.length === 0) return;
  const [first, ...rest] = points;
  const bounds = rest.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(first, first));
  map.fitBounds(bounds, { padding: 60 });
}

function showRoute(route: Route): void {
  state.shownRouteId = route.id;
  state.shownPlanId = null;
  setSummary(routeSummary(route));
  renderRoutes();
  renderPlans();
  renderMarkers();
  map.getSource<maplibregl.GeoJSONSource>("plan")?.setData(emptyLine);
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
  fitTo(route.geometry);
}

// Hides whatever is drawn (a route, its stop numbers or a plan). Nothing is deleted.
function clearShownRoute(): void {
  state.shownRouteId = null;
  state.shownPlanId = null;
  pendingRoute = null;
  setSummary();
  map.getSource<maplibregl.GeoJSONSource>("route")?.setData(emptyLine);
  map.getSource<maplibregl.GeoJSONSource>("plan")?.setData(emptyLine);
  renderRoutes();
  renderPlans();
  renderMarkers();
}

// Draws every calculated route of a plan together, each in its own colour, and fits the map to them.
const PLAN_COLORS = ["#d9480f", "#1971c2", "#2b8a3e", "#9c36b5", "#e8590c", "#0c8599"];

function showPlan(plan: Plan): void {
  state.shownPlanId = plan.id;
  state.shownRouteId = null;
  pendingRoute = null;
  map.getSource<maplibregl.GeoJSONSource>("route")?.setData(emptyLine);
  const legs = plan.route_ids
    .map((id, index) => ({ route: state.routes.find((r) => r.id === id), color: PLAN_COLORS[index % PLAN_COLORS.length] }))
    .filter((leg): leg is { route: Route; color: string } => leg.route !== undefined);
  const drawn = legs.filter(({ route }) => route.geometry && route.geometry.length > 1);
  map.getSource<maplibregl.GeoJSONSource>("plan")?.setData({
    type: "FeatureCollection",
    features: drawn.map(({ route, color }) => ({
      type: "Feature" as const,
      properties: { color },
      geometry: { type: "LineString" as const, coordinates: route.geometry as LonLat[] },
    })),
  });
  setSummary(
    h("div", {}, `${plan.name}: ${planTotals(plan)}`),
    ...legs.map(({ route, color }, index) =>
      h("div", {}, h("span", { className: "swatch", style: `background:${color}` }), ` ${index + 1}. ${route.name}${route.geometry ? "" : " (not calculated)"}`),
    ),
  );
  renderRoutes();
  renderPlans();
  renderMarkers();
  fitTo(drawn.flatMap(({ route }) => route.geometry as LonLat[]));
}

// The dashed line shown while an optimize proposal is being reviewed.
function drawPreview(geometry: LonLat[] | null): void {
  const source = map.getSource<maplibregl.GeoJSONSource>("preview");
  if (!source) return;
  if (!geometry || geometry.length < 2) {
    source.setData(emptyLine);
    return;
  }
  source.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: geometry } });
  fitTo(geometry);
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
  const routeAction = h("button", {
    className: "folder-action",
    title: `Make a route from ${ticked(ids) ? "the ticked POIs in" : "all"} this folder`,
    onclick: () => run(() => routeFromFolder(tag, pois)),
  }, "route");
  const deleteAction = folderDeleteButton(tag, pois);
  if (!tag) return [selectAll, routeAction, tagAll, deleteAction];
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
  return [selectAll, routeAction, tagAll, untagAll, deleteAction];
}

// Deletes the folder's ticked POIs if any are ticked, otherwise every POI in the folder. The label says which.
function folderDeleteButton(tag: string, pois: POI[]): HTMLElement {
  const ids = pois.map((poi) => poi.id);
  const tickedCount = ids.filter((id) => state.selected.includes(id)).length;
  const scope = tickedCount ? `${tickedCount} selected` : `all ${pois.length}`;
  return h("button", {
    className: "folder-action danger",
    title: tickedCount
      ? `Delete the ${tickedCount} ticked POIs in this folder (permanent)`
      : `Delete all ${pois.length} POIs in this folder (permanent)`,
    onclick: () => run(() => deleteFolderPois(tag, pois)),
  }, `delete ${scope}`);
}

// Permanent, and not undoable: a recreated POI would get a new id and its route stops would be gone. So the
// confirm spells out what goes: the count, the routes that lose stops, and POIs that also sit in other folders.
async function deleteFolderPois(tag: string, pois: POI[]): Promise<void> {
  const inFolder = new Set(pois.map((poi) => poi.id));
  const tickedIds = state.selected.filter((id) => inFolder.has(id));
  const targets = tickedIds.length ? pois.filter((poi) => tickedIds.includes(poi.id)) : pois;
  const targetIds = new Set(targets.map((poi) => poi.id));
  const folder = tag || UNTAGGED;
  const scope = tickedIds.length
    ? `the ${targets.length} ticked POI${targets.length === 1 ? "" : "s"} in "${folder}"`
    : `all ${targets.length} POI${targets.length === 1 ? "" : "s"} in "${folder}"`;

  const hitRoutes = state.routes.filter((route) => route.poi_ids.some((id) => targetIds.has(id)));
  const shownNames = hitRoutes.slice(0, 3).map((route) => `"${route.name}"`);
  const more = hitRoutes.length > shownNames.length ? ` and ${hitRoutes.length - shownNames.length} more` : "";
  const otherTags = targets.filter((poi) => poi.tags.some((t) => t !== tag)).length;

  const lines = [`Permanently delete ${scope}? This cannot be undone.`];
  if (hitRoutes.length) {
    lines.push(
      `${hitRoutes.length} route${hitRoutes.length === 1 ? "" : "s"} will lose stops: ${shownNames.join(", ")}${more}.`,
    );
  }
  if (otherTags) {
    lines.push(
      `${otherTags} of them also have other tags. They are deleted everywhere, not only from "${folder}".`,
    );
  }
  if (!(await askConfirm(lines.join("\n\n"), "Delete"))) return;

  try {
    await forEachPoi(targets, (poi) => api.deletePoi(poi.id));
  } finally {
    // Even if a delete fails part way, the rows that did go leave the selection and the list is reloaded.
    state.selected = state.selected.filter((id) => !targetIds.has(id));
    await refresh();
  }
}

function ticked(ids: number[]): boolean {
  return ids.some((id) => state.selected.includes(id));
}

// A route from a folder: its ticked POIs in tick order if any are ticked, otherwise every POI in it.
// The line is calculated in that order; nothing reorders the stops.
async function routeFromFolder(tag: string, pois: POI[]): Promise<void> {
  const inFolder = new Set(pois.map((poi) => poi.id));
  const tickedIds = state.selected.filter((id) => inFolder.has(id));
  const poiIds = tickedIds.length ? tickedIds : pois.map((poi) => poi.id);
  if (poiIds.length < 2) {
    notify("A route needs at least two POIs. Tick two, or put more POIs in this folder.");
    return;
  }
  const name = (await askText("Route name?", tag || "Untagged route"))?.trim();
  if (!name) return;
  const profile = (await askText("Profile: car or fun?", "car"))?.trim();
  if (profile !== "car" && profile !== "fun") {
    notify('The profile must be "car" or "fun".');
    return;
  }
  // The stops are kept in the order chosen (tick order, or the folder's displayed order). No reordering.
  const route = await api.createRoute({ name, profile, poi_ids: poiIds });
  state.selected = [];
  const calculated = await api.calculateRoute(route.id, false);
  await refresh();
  showRoute(calculated);
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
  staleRoutes.delete(route.id);
  await refresh();
  showRoute(updated);
}

async function optimize(route: Route): Promise<void> {
  if (!(await confirmReplaceImported(route, "Optimizing"))) return;
  const preview = await api.previewOptimize(route.id, route.geometry_source === "imported");
  if (preview.source === "none") {
    notify("Need at least three stops to reorder.");
    return;
  }
  if (preview.proposed.poi_ids.join() === preview.current.poi_ids.join()) {
    notify(`"${route.name}" is already in the best order.`);
    return;
  }
  await reviewOrder(route, preview);
}

// Nothing is saved until Accept. Accepting stores the proposed order and calculates the line again.
async function reviewOrder(route: Route, preview: OptimizePreview): Promise<void> {
  drawPreview(preview.geometry);
  const message = [
    `Current order: ${orderTotals(preview.current)}.`,
    `Proposed order: ${orderTotals(preview.proposed)}.`,
    preview.geometry
      ? "The dashed blue line is the proposed route."
      : "GraphHopper gave no line for the proposed order.",
    "Accept saves the new order and calculates the line. Reject changes nothing.",
  ].join("\n");
  let accepted: boolean;
  try {
    accepted = await askDecision(message, "Accept", "Reject");
  } finally {
    drawPreview(null);
  }
  if (!accepted) return;
  await api.updateRoute(route.id, { poi_ids: preview.proposed.poi_ids });
  const updated = await api.calculateRoute(route.id, false);
  await refresh();
  showRoute(updated);
}

// Replaces a route's stops (after a move or a removal). Changing stops clears the cached line, so the
// route is marked stale until the user presses recalc. Nothing else reorders or recalculates.
async function setStops(route: Route, poiIds: number[]): Promise<void> {
  const updated = await api.updateRoute(route.id, { poi_ids: poiIds });
  staleRoutes.add(route.id);
  await refresh();
  if (state.shownRouteId === route.id) showRoute(updated);
}

// The stops of a route, in order. Clicking a name flies the map to it.
function renderStops(route: Route): HTMLElement {
  const last = route.poi_ids.length - 1;
  const move = (index: number, step: number) => {
    const ids = [...route.poi_ids];
    [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
    return setStops(route, ids);
  };
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
        h("button", { title: "Move stop up", disabled: index === 0, onclick: () => run(() => move(index, -1)) }, "↑"),
        h("button", { title: "Move stop down", disabled: index === last, onclick: () => run(() => move(index, 1)) }, "↓"),
        h("button", {
          title: "Remove this stop from the route",
          onclick: () => run(() => setStops(route, route.poi_ids.filter((_, i) => i !== index))),
        }, "remove"),
      );
    }),
  );
}

// A route can be added to a plan from its own row, as well as from the plan.
function planPicker(route: Route): HTMLElement {
  const available = state.plans.filter((plan) => !plan.route_ids.includes(route.id));
  const select: HTMLSelectElement = h(
    "select",
    {
      className: "plan-picker",
      title: "Add this route to a plan",
      onchange: () => {
        const plan = state.plans.find((p) => p.id === Number(select.value));
        select.value = "";
        if (plan) void setPlanRoutes(plan, [...plan.route_ids, route.id]);
      },
    },
    h("option", { value: "" }, !state.plans.length ? "no plans yet" : available.length ? "add to plan…" : "in every plan"),
    ...available.map((plan) => h("option", { value: String(plan.id) }, plan.name)),
  );
  return select;
}

function renderRouteItem(route: Route): HTMLElement {
  const expanded = expandedRoutes.has(route.id);
  const stale = staleRoutes.has(route.id);
  const shown = state.shownRouteId === route.id;
  const toggleStops = () => {
    if (expanded) expandedRoutes.delete(route.id);
    else expandedRoutes.add(route.id);
    renderRoutes();
  };
  return h(
    "li",
    { className: shown ? "route shown" : "route" },
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
        {
          className: "name",
          title: `Show ${route.name} on the map`,
          onclick: () => showRoute(route),
        },
        `${route.name} (${route.geometry_source === "imported" ? "track" : route.profile})`,
      ),
    ),
    h(
      "div",
      { className: "route-actions" },
      h("button", {
        className: "show-route",
        title: shown ? "Hide this route and its stop numbers" : "Draw this route on the map",
        onclick: () => (shown ? clearShownRoute() : showRoute(route)),
      }, shown ? "hide" : "show"),
      h(
        "span",
        { className: "meta" },
        stale
          ? "order changed, recalc"
          : route.distance_m == null
            ? `${route.poi_ids.length} stops, not calculated`
            : formatKm(route.distance_m),
      ),
      h("button", {
        className: stale ? "recalc-route" : "",
        title: "Calculate the line through the stops in this order",
        onclick: () => run(() => calculate(route)),
      }, stale ? "recalc" : "calc"),
      h("button", {
        title: "Review a shorter stop order before saving it",
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
      planPicker(route),
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
    ...(expanded
      ? [
          renderStops(route),
          h("p", { className: "hint stops-hint" }, "The stops stay in this order. After a change, press recalc to draw the line through them."),
        ]
      : []),
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
  const list = $("plan-list");
  if (state.plans.length === 0) {
    list.replaceChildren(
      h(
        "li",
        { className: "hint empty-plans" },
        'No plans yet. A plan is one trip made of routes in order. For example, create "Georgia loop", then add "Day 1 north" and "Day 2 south" to it.',
      ),
    );
    return;
  }
  list.replaceChildren(
    ...state.plans.map((plan) => {
      const shown = state.shownPlanId === plan.id;
      return h(
        "li",
        { className: shown ? "plan shown" : "plan" },
        h(
          "div",
          { className: "plan-head" },
          h("span", { className: "name", title: plan.name }, plan.name),
          h("button", {
            className: "show-route",
            title: shown ? "Hide this plan's routes" : "Draw all of this plan's routes on the map together",
            onclick: () => (shown ? clearShownRoute() : showPlan(plan)),
          }, shown ? "hide" : "show"),
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
                if (state.shownPlanId === plan.id) clearShownRoute();
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
      );
    }),
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
  labelMode = LABEL_MODES.find((mode) => mode === labelSelect.value) ?? DEFAULT_LABEL_MODE;
  try {
    localStorage.setItem(LABEL_KEY, labelMode);
  } catch {
    // Not stored; the choice still applies to this page view.
  }
  renderMarkers();
};

// Sidebar width: drag the handle (or use arrow keys on it); double-click resets. Remembered per browser.
const SIDEBAR_KEY = "route-camp.sidebar-width";
const SIDEBAR_DEFAULT = 340;
const SIDEBAR_MIN = 220;
const MAP_MIN = 300; // the map always keeps at least this much width

function setSidebarWidth(width: number, save = true): void {
  const max = Math.max(SIDEBAR_MIN, window.innerWidth - MAP_MIN);
  const clamped = Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)));
  document.body.style.setProperty("--sidebar-width", `${clamped}px`);
  map.resize();
  if (!save) return;
  try {
    localStorage.setItem(SIDEBAR_KEY, String(clamped));
  } catch {
    // Not stored; the width still applies to this page view.
  }
}

try {
  const stored = Number(localStorage.getItem(SIDEBAR_KEY));
  if (stored) setSidebarWidth(stored, false);
} catch {
  // Storage unavailable: keep the default width.
}

const resizer = $("sidebar-resizer");
resizer.onpointerdown = (event: PointerEvent) => {
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add("dragging");
  document.body.classList.add("resizing");
};
resizer.onpointermove = (event: PointerEvent) => {
  if (resizer.hasPointerCapture(event.pointerId)) setSidebarWidth(event.clientX, false);
};
const endResize = (event: PointerEvent) => {
  if (!resizer.hasPointerCapture(event.pointerId)) return;
  resizer.releasePointerCapture(event.pointerId);
  resizer.classList.remove("dragging");
  document.body.classList.remove("resizing");
  setSidebarWidth($("sidebar").getBoundingClientRect().width);
};
resizer.onpointerup = endResize;
resizer.onpointercancel = endResize;
resizer.ondblclick = () => setSidebarWidth(SIDEBAR_DEFAULT);
resizer.onkeydown = (event: KeyboardEvent) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const width = $("sidebar").getBoundingClientRect().width;
  setSidebarWidth(width + (event.key === "ArrowRight" ? 20 : -20));
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
