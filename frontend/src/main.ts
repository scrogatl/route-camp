import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { askConfirm, askDecision, askText, hideUndo, showMessage, showUndo } from "./dialogs";
import {
  api,
  type ImportSummary,
  type RallyImportSummary,
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
  selectedRoutes: [] as number[], // ticked route ids, for tagging several routes at once
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
    } else if (key.startsWith("aria-") || key.startsWith("data-")) {
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

const formatMiles = (metres: number): string => `${(metres / 1609.344).toFixed(1)} mi`;

const formatPoints = (points: number): string => points.toLocaleString("en-US");

// Points for a set of stops. Each bonus counts once, so Rally HQ at both ends (or a bonus on two routes) isn't doubled.
function pointsFor(poiIds: number[]): number {
  return [...new Set(poiIds)].reduce((sum, id) => sum + (state.pois.find((p) => p.id === id)?.score ?? 0), 0);
}

const pointsText = (poiIds: number[]): string => `${formatPoints(pointsFor(poiIds))} points`;

// Total time with the stop part, e.g. "10 h 49 min (1 h 20 min at stops)". Drive time alone when no stop time.
function formatTotal(driveSeconds: number, stopSeconds: number): string {
  if (stopSeconds <= 0) return formatDuration(driveSeconds);
  return `${formatDuration(driveSeconds + stopSeconds)} (${formatDuration(stopSeconds)} at stops)`;
}

// The longer form for a single route: "9 h 29 min driving + 1 h 20 min at 16 stops = 10 h 49 min".
function timeBreakdown(route: Route): string {
  if (route.time_s == null) return "";
  const counted = countedStops(route.poi_ids);
  if (route.stop_s <= 0) return `${formatDuration(route.time_s)} driving`;
  return `${formatDuration(route.time_s)} driving + ${formatDuration(route.stop_s)} at ${counted} stop${counted === 1 ? "" : "s"} = ${formatDuration(route.time_s + route.stop_s)}`;
}

// Default minutes at each stop (from /api/settings). A POI's own stop_minutes overrides it.
let defaultStopMinutes = 5;
// Rally start, minutes after midnight (from /api/settings), for the route table's arrival times.
let startMinutes = 8 * 60;

// Minutes at one stop, as the backend counts them (app/stop_time.py): the POI's own minutes, else the
// default, except the first and last stops (Rally HQ), which count only with their own minutes.
function stopMinutesAt(poiIds: number[], index: number): number {
  const poi = state.pois.find((p) => p.id === poiIds[index]);
  if (poi?.stop_minutes != null) return poi.stop_minutes;
  return index === 0 || index === poiIds.length - 1 ? 0 : defaultStopMinutes;
}

function countedStops(poiIds: number[]): number {
  return poiIds.filter((_, index) => stopMinutesAt(poiIds, index) > 0).length;
}

function stopSecondsFor(poiIds: number[]): number {
  return 60 * poiIds.reduce((sum, _, index) => sum + stopMinutesAt(poiIds, index), 0);
}

const formatMinutes = (minutes: number): string => `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;

// Route row summary: distance, driving time and stop count. Imported GPX tracks have no time until calculated.
function routeStats(route: Route): string {
  const stops = `${route.poi_ids.length} stop${route.poi_ids.length === 1 ? "" : "s"}`;
  if (route.distance_m == null) return `${stops} · ${pointsText(route.poi_ids)}, not calculated`;
  const time = route.time_s == null ? "no time (GPX track)" : formatTotal(route.time_s, route.stop_s);
  return `${formatMiles(route.distance_m)} · ${time} · ${stops} · ${pointsText(route.poi_ids)}`;
}

function routeSummary(route: Route): string {
  if (route.distance_m == null || !route.geometry) return `${route.name}: not calculated yet.`;
  const origin = route.geometry_source === "imported" ? "GPX track" : route.profile;
  const time = route.time_s == null ? "no time" : timeBreakdown(route);
  return `${route.name} (${origin}): ${formatMiles(route.distance_m)}, ${time}, ${pointsText(route.poi_ids)}`;
}

function orderTotals(order: OrderSummary): string {
  if (order.distance_m == null) return "no distance (GraphHopper unavailable)";
  const time = order.time_s == null ? "no time" : formatDuration(order.time_s);
  return `${formatMiles(order.distance_m)}, ${time}`;
}

// Replaces the route summary under the Routes section (text, or nodes for the plan legend).
function setSummary(...content: (Node | string)[]): void {
  $("route-summary").replaceChildren(...content);
}

function planTotals(plan: Plan): string {
  if (plan.routes_total === 0) return "no routes yet";
  const poiIds = plan.route_ids.flatMap((id) => state.routes.find((r) => r.id === id)?.poi_ids ?? []);
  const parts = [formatMiles(plan.distance_m), pointsText(poiIds)];
  if (plan.routes_with_time === 0) {
    parts.push("no time");
  } else {
    parts.push(formatTotal(plan.time_s, plan.stop_s) + (plan.routes_with_time < plan.routes_total ? " (partial)" : ""));
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

function rallyImportMessage(summary: RallyImportSummary): string {
  const created = summary.created.length ? ` (${summary.created.slice(0, 10).join(", ")}${summary.created.length > 10 ? ", …" : ""})` : "";
  return [
    `Rally CSV: ${summary.bonuses} bonus${summary.bonuses === 1 ? "" : "es"}.`,
    `POIs: ${summary.pois_created} new${created}, ${summary.pois_matched} already there.`,
    `${summary.pois_updated} of those got new points or a state.`,
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

// POI folders start collapsed on every page load (there can be well over a hundred POIs); opening one lasts
// for this page view only. Other folders and the sections keep their remembered state. Keys stored by
// earlier versions for POI folders are dropped.
const openPoiFolders = new Set<string>();
const isPoiFolder = (key: string): boolean => key.startsWith("poi/");
if ([...collapsed].some(isPoiFolder)) {
  for (const key of [...collapsed].filter(isPoiFolder)) setCollapsed(key, false);
}

function isFolderCollapsed(key: string): boolean {
  return isPoiFolder(key) ? !openPoiFolders.has(key) : collapsed.has(key);
}

function setFolderCollapsed(key: string, value: boolean): void {
  if (!isPoiFolder(key)) setCollapsed(key, value);
  else if (value) openPoiFolders.delete(key);
  else openPoiFolders.add(key);
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
    paint: { "line-color": "#1f5fbf", "line-width": 4 },
  });
  map.addSource("preview", { type: "geojson", data: emptyLine });
  map.addLayer({
    id: "preview-line",
    type: "line",
    source: "preview",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#e07b00", "line-width": 4, "line-dasharray": [2, 2] },
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
    // A ticked POI that is not a stop of the shown route shows its place in the selection order.
    const order = state.selected.indexOf(poi.id) + 1;
    const classes = ["marker"];
    if (order) classes.push("selected");
    if (stop) classes.push("stop");
    else if (order) classes.push("numbered");
    const label = labelFor(poi);
    const element = h(
      "div",
      { className: "poi-pin" },
      h(
        "div",
        {
          className: classes.join(" "),
          title: stop ? `Stop ${stop}: ${poi.name}` : order ? `Selected ${order}: ${poi.name}` : poi.name,
          onclick: (event: Event) => {
            event.stopPropagation();
            toggleSelected(poi.id);
          },
        },
        stop ?? (order ? String(order) : ""),
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
// Blues and oranges only (no red/green pairs), alternating so neighbouring days stand apart.
const PLAN_COLORS = ["#1f5fbf", "#e07b00", "#0b3d91", "#ffb766", "#5b9bff", "#9a4a00"];

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
      const isCollapsed = isFolderCollapsed(key);
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
                setFolderCollapsed(key, !isCollapsed);
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
  renderSelection();
}

// Everything that shows the selection: POI list, "add ticked (N)" on expanded routes, markers, the
// Selected list and the Bonuses table. They all read state.selected, so ticking anywhere shows everywhere.
function renderSelection(): void {
  renderPois();
  renderRoutes();
  renderMarkers();
  renderSelected();
  renderBonuses();
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

// Sets a POI's own minutes at the stop, used in every route it is on. Blank goes back to the default.
async function editStopMinutes(poi: POI): Promise<void> {
  const input = await askText(
    `Minutes at "${poi.name}"? Blank uses the default (${formatMinutes(defaultStopMinutes)}).`,
    poi.stop_minutes == null ? "" : String(poi.stop_minutes),
  );
  if (input === null) return;
  const text = input.trim();
  const minutes = Number(text);
  if (text !== "" && !(Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440)) {
    notify("Minutes at a stop is a number from 0 to 1440.");
    return;
  }
  await api.updatePoi(poi.id, { stop_minutes: text === "" ? null : minutes });
  await refresh();
}

// "⏱ 5" for a POI on the default, "⏱ 20" in bold for one with its own minutes; click to change.
function stopMinutesButton(poi: POI, minutes = poi.stop_minutes ?? defaultStopMinutes): HTMLElement {
  const own = poi.stop_minutes != null;
  return h("button", {
    className: own ? "stop-minutes own" : "stop-minutes",
    title: own
      ? `${formatMinutes(poi.stop_minutes!)} at ${poi.name} (its own). Click to change; blank goes back to the default.`
      : minutes === defaultStopMinutes
        ? `${formatMinutes(minutes)} at ${poi.name} (the default). Click to give it its own minutes.`
        : `No stop time at ${poi.name}: the first and last stops count only with their own minutes. Click to set them.`,
    onclick: () => run(() => editStopMinutes(poi)),
  }, `⏱ ${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}`);
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
      className: "danger",
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
      renderSelection();
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
  revealRoute(route.id);
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

// --- Selected: the ticked bonuses, in the order the route will take -------------

function selectedPois(): POI[] {
  return state.selected
    .map((id) => state.pois.find((poi) => poi.id === id))
    .filter((poi): poi is POI => poi !== undefined);
}

function selectionTotals(): string {
  const pois = selectedPois();
  const points = pois.reduce((sum, poi) => sum + (poi.score ?? 0), 0);
  const stopSeconds = stopSecondsFor(state.selected);
  const stops = stopSeconds > 0 ? ` · ${formatDuration(stopSeconds)} at stops` : "";
  return `${pois.length} selected · ${formatPoints(points)} points${stops}`;
}

function setSelectedOrder(ids: number[]): void {
  state.selected = ids;
  renderSelection();
}

// Drag a ⠿ handle to move a row of an ordered list (the Selected card, a route's stops). Pointer events,
// so a mouse, pen or finger all work; ↑ / ↓ and the position number do the same from the keyboard. Only
// the user's moves change an order. On drop, onDrop gets the rows' data-key values in their new order.
// Listens on the window, not with pointer capture: moving the row in the DOM would drop the capture.
function startDrag(event: PointerEvent, item: HTMLElement, onDrop: (keys: string[]) => void): void {
  const list = item.parentElement as HTMLElement;
  const before = [...list.children].map((el) => (el as HTMLElement).dataset.key ?? "");
  // Near the top or bottom edge of the scrolling panel, scroll it so a row can go anywhere in a long list.
  const scroller = item.closest<HTMLElement>("#sidebar, #bonuses-view");
  event.preventDefault();
  item.classList.add("dragging");
  document.body.classList.add("reordering");
  const move = (e: PointerEvent) => {
    if (scroller) {
      const edges = scroller.getBoundingClientRect();
      if (e.clientY < edges.top + 40) scroller.scrollTop -= 12;
      else if (e.clientY > edges.bottom - 40) scroller.scrollTop += 12;
    }
    const target = [...list.children].find((el) => {
      if (el === item) return false;
      const box = el.getBoundingClientRect();
      return e.clientY >= box.top && e.clientY <= box.bottom;
    });
    if (!target) return;
    const box = target.getBoundingClientRect();
    const next = e.clientY < box.top + box.height / 2 ? target : target.nextSibling;
    if (next !== item && next !== item.nextSibling) list.insertBefore(item, next);
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    item.classList.remove("dragging");
    document.body.classList.remove("reordering");
    const keys = [...list.children].map((el) => (el as HTMLElement).dataset.key ?? "");
    if (keys.join() !== before.join()) onDrop(keys);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

// Moves one item of an ordered list to another position (1-based), keeping the rest in order.
function moveTo<T>(items: T[], from: number, to: number): T[] {
  const result = [...items];
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved);
  return result;
}

// The position number of a row is a button: type a new position to jump there instead of pressing ↑ / ↓.
function positionButton(index: number, count: number, name: string, apply: (to: number) => void | Promise<void>): HTMLElement {
  return h("button", {
    className: "stop-number position",
    title: `Move ${name} to another position`,
    "aria-label": `Position ${index + 1} of ${count}: ${name}. Move to another position`,
    onclick: () =>
      run(async () => {
        const input = await askText(`Move "${name}" from ${index + 1} to which position (1 to ${count})?`, String(index + 1));
        if (input === null) return;
        const to = Number(input.trim());
        if (!Number.isInteger(to) || to < 1 || to > count) {
          notify(`A position is a whole number from 1 to ${count}.`);
          return;
        }
        if (to !== index + 1) await apply(to - 1);
      }),
  }, String(index + 1));
}

function renderSelected(): void {
  const pois = selectedPois();
  const last = pois.length - 1;
  $("selected-count").textContent = pois.length ? `(${pois.length})` : "";
  $("selected-total").textContent = selectionTotals();
  $("selected-list").replaceChildren(
    ...pois.map((poi, index) => {
      const move = (step: number) => {
        const ids = [...state.selected];
        [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
        setSelectedOrder(ids);
      };
      const item: HTMLElement = h(
        "li",
        { className: "selected-item" },
        h("span", {
          className: "drag-handle",
          title: "Drag to move",
          "aria-hidden": "true",
          onpointerdown: (event: PointerEvent) =>
            startDrag(event, item, (keys) => setSelectedOrder(keys.map(Number))),
        }, "⠿"),
        positionButton(index, pois.length, poi.name, (to) => setSelectedOrder(moveTo(state.selected, index, to))),
        h("span", {
          className: "name",
          title: poi.name,
          onclick: () => {
            setView("map");
            map.flyTo({ center: [poi.lon, poi.lat], zoom: 12 });
          },
        }, poi.name),
        h("span", { className: "meta" }, poi.score == null ? "" : formatPoints(poi.score)),
        h("button", { title: "Move up", "aria-label": `Move ${poi.name} up`, disabled: index === 0, onclick: () => move(-1) }, "↑"),
        h("button", { title: "Move down", "aria-label": `Move ${poi.name} down`, disabled: index === last, onclick: () => move(1) }, "↓"),
        h("button", {
          title: "Remove from the selection",
          "aria-label": `Remove ${poi.name}`,
          onclick: () => setSelectedOrder(state.selected.filter((id) => id !== poi.id)),
        }, "×"),
      );
      item.dataset.key = String(poi.id);
      return item;
    }),
  );
  if (!pois.length) $("selected-list").append(h("li", { className: "hint" }, "Nothing selected yet."));

  const picker = $<HTMLSelectElement>("append-route");
  const current = picker.value;
  picker.replaceChildren(
    h("option", { value: "" }, state.routes.length ? "append to route…" : "no routes yet"),
    ...state.routes
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((route) => h("option", { value: String(route.id) }, route.name)),
  );
  if (state.routes.some((route) => String(route.id) === current)) picker.value = current;
  ($("route-create") as HTMLButtonElement).disabled = pois.length < 2;
  ($("append-selected") as HTMLButtonElement).disabled = pois.length === 0;
}

// --- Typed or pasted list -> selection ------------------------------------------

// POIs a piece of text names: an exact name (any case) first, otherwise names that start with it and a
// space, so a rally code "ABAC" finds "ABAC 510".
function poisNamed(text: string): POI[] {
  const wanted = text.toUpperCase();
  const exact = state.pois.filter((poi) => poi.name.toUpperCase() === wanted);
  return exact.length ? exact : state.pois.filter((poi) => poi.name.toUpperCase().startsWith(wanted + " "));
}

interface ListMatch {
  ids: number[]; // in the order listed, each once
  missing: string[];
  ambiguous: string[];
  repeated: string[];
}

// Reads a list in route order. Pieces are split on new lines, commas, semicolons, tabs and arrows; within
// a piece, words are matched greedily, longest first, so "Rally HQ Warner Robins ABAC BLHD" on one line
// still finds the multi-word name and the two codes.
function matchBonusList(text: string): ListMatch {
  const result: ListMatch = { ids: [], missing: [], ambiguous: [], repeated: [] };
  const add = (poi: POI, label: string) => {
    if (result.ids.includes(poi.id)) result.repeated.push(label);
    else result.ids.push(poi.id);
  };
  for (const piece of text.split(/[\n,;\t]|→|->/)) {
    const words = piece.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      // The longest run of words from i that names exactly one POI; a single word that doesn't is reported.
      let j = words.length;
      while (j > i + 1 && poisNamed(words.slice(i, j).join(" ")).length !== 1) j--;
      const label = words.slice(i, j).join(" ");
      const pois = poisNamed(label);
      if (pois.length === 1) add(pois[0], label);
      else (pois.length > 1 ? result.ambiguous : result.missing).push(label);
      i = j;
    }
  }
  return result;
}

function applyBonusList(replace: boolean): void {
  const textarea = $<HTMLTextAreaElement>("paste-text");
  const match = matchBonusList(textarea.value);
  if (!match.ids.length && !match.missing.length && !match.ambiguous.length) {
    notify("Type or paste some bonus codes first.");
    return;
  }
  const base = replace ? [] : state.selected;
  const added = match.ids.filter((id) => !base.includes(id));
  setSelectedOrder([...base, ...added]);
  const problems = [
    match.missing.length ? `Not found: ${match.missing.join(", ")}.` : "",
    match.ambiguous.length ? `More than one POI matches: ${match.ambiguous.join(", ")}. Type the full name.` : "",
    match.repeated.length ? `Listed twice (kept the first): ${match.repeated.join(", ")}.` : "",
    !replace && added.length < match.ids.length ? `${match.ids.length - added.length} were already selected.` : "",
  ].filter(Boolean);
  if (problems.length) {
    notify([`Selected ${added.length} of the listed bonuses.`, ...problems].join("\n"));
  } else {
    textarea.value = ""; // everything matched; nothing left to fix
  }
}

// Brings a route's row into view in the sidebar: opens the Routes section and the route's folders if they
// were collapsed, then scrolls to it. Used after creating or appending, since a new untagged route lands
// in the last folder, far below the Selected card.
function revealRoute(routeId: number): void {
  const route = state.routes.find((r) => r.id === routeId);
  if (!route) return;
  setCollapsed("section/routes", false);
  $("routes-body").hidden = false;
  document.querySelector('.section-toggle[data-section="routes"]')?.setAttribute("aria-expanded", "true");
  for (const tag of route.tags.length ? route.tags : [""]) setCollapsed(`route/${tag}`, false);
  renderRoutes();
  const row = document.querySelector<HTMLElement>(`li.route[data-route-id="${routeId}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("just-added");
  setTimeout(() => row.classList.remove("just-added"), 2500);
}

// --- Route table: the stops with points, miles and arrival times -----------------

// "07:45", or "00:15 +1d" past midnight.
function formatClock(minutes: number): string {
  const whole = Math.round(minutes);
  const days = Math.floor(whole / 1440);
  const inDay = whole - days * 1440;
  const clock = `${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}`;
  return days > 0 ? `${clock} +${days}d` : clock;
}

const clockValue = (minutes: number): string => formatClock(minutes % 1440);

let routeTableDialog: HTMLDialogElement | null = null;

// Opens the table for a route (by id, so a later refresh shows the current stops). Arrival at each stop is
// the start time plus the driving of the legs before it plus the minutes stopped at the stops before it.
// The leg times are saved when the route is calculated, so the table opens without GraphHopper.
function showRouteTable(routeId: number): void {
  if (!routeTableDialog) {
    routeTableDialog = document.createElement("dialog");
    routeTableDialog.id = "route-table-dialog";
    document.body.append(routeTableDialog);
  }
  renderRouteTable(routeId);
  if (!routeTableDialog.open) routeTableDialog.showModal();
}

function renderRouteTable(routeId: number): void {
  const box = routeTableDialog;
  const route = state.routes.find((r) => r.id === routeId);
  if (!box || !route) return;
  const ids = route.poi_ids;
  const legs = route.legs?.length === ids.length - 1 ? route.legs : null;
  let clock = startMinutes;
  let points = 0;
  const counted = new Set<number>();
  const rows = ids.map((id, index) => {
    const poi = state.pois.find((p) => p.id === id);
    const leg = index > 0 && legs ? legs[index - 1] : null;
    if (leg) clock += leg.time_s / 60;
    const arrive = index === 0 ? formatClock(startMinutes) : legs ? formatClock(clock) : "";
    const stop = stopMinutesAt(ids, index);
    clock += stop;
    if (poi?.score != null && !counted.has(id)) {
      counted.add(id);
      points += poi.score;
    }
    return h(
      "tr",
      {},
      h("td", { className: "num" }, String(index + 1)),
      h("td", {}, poi?.name ?? "(deleted)"),
      h("td", { className: "num" }, poi?.score == null ? "" : formatPoints(poi.score)),
      h("td", { className: "num" }, formatPoints(points)),
      h("td", { className: "num" }, leg ? (leg.distance_m / 1609.344).toFixed(1) : ""),
      h("td", { className: "num" }, arrive),
      h("td", { className: "num" }, stop > 0 ? formatMinutes(stop) : ""),
    );
  });
  const startInput = h("input", {
    type: "time",
    value: clockValue(startMinutes),
    onchange: () =>
      run(async () => {
        const [hours, minutes] = startInput.value.split(":").map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return;
        startMinutes = hours * 60 + minutes;
        renderRouteTable(routeId);
        await api.updateSettings({ start_minutes: startMinutes });
      }),
  });
  const note = legs
    ? `Finish ${formatClock(clock)}. Arrival counts driving plus the minutes at earlier stops.`
    : route.geometry_source === "imported"
      ? "A GPX track has no time per leg: press calc on the route for arrival times."
      : "Not calculated: press calc on the route for miles and arrival times.";
  box.replaceChildren(
    h("h2", {}, route.name),
    h("p", { className: "meta" }, routeStats(route)),
    h("label", { className: "start-time" }, "Start ", startInput),
    h(
      "div",
      { className: "table-wrap" },
      h(
        "table",
        { className: "route-table" },
        h("thead", {}, h("tr", {}, ...["#", "Bonus", "Points", "Total", "Leg mi", "Arrive", "Stop"].map((label) => h("th", { className: label === "Bonus" ? "" : "num" }, label)))),
        h("tbody", {}, ...rows),
      ),
    ),
    h("p", { className: "hint" }, note),
    h(
      "div",
      { className: "dialog-buttons no-print" },
      h("button", { onclick: () => window.print() }, "Print"),
      h("button", { className: "primary", onclick: () => box.close() }, "Close"),
    ),
  );
}

// Copies a route under a new name (asked for, "<name> (copy)" by default), then shows and reveals the copy.
async function duplicate(route: Route): Promise<void> {
  const name = (await askText("Name for the copy?", `${route.name} (copy)`))?.trim();
  if (!name) return;
  const copy = await api.duplicateRoute(route.id, name);
  await refresh();
  showRoute(copy);
  revealRoute(copy.id);
}

// Creates the route through the selection in exactly its order, then calculates the line in that order.
async function createRouteFromSelection(): Promise<void> {
  const nameInput = $<HTMLInputElement>("route-name");
  const name = nameInput.value.trim();
  if (state.selected.length < 2) {
    notify("Select at least two bonuses.");
    return;
  }
  if (!name) {
    notify("Name the route first.");
    nameInput.focus();
    return;
  }
  const profile = $<HTMLSelectElement>("route-profile").value as Profile;
  const route = await api.createRoute({ name, profile, poi_ids: [...state.selected] });
  nameInput.value = "";
  state.selected = [];
  setView("map");
  try {
    const calculated = await api.calculateRoute(route.id, false);
    await refresh();
    showRoute(calculated);
    revealRoute(route.id);
  } catch (err) {
    // The route is saved either way; only its line is missing, and calc retries it.
    await refresh();
    showRoute(state.routes.find((r) => r.id === route.id) ?? route);
    revealRoute(route.id);
    throw err;
  }
}

// Adds the selection to the end of an existing route, in order, skipping stops it already has.
// Like any stop change, the line is cleared until the user presses recalc.
async function appendSelectionToRoute(): Promise<void> {
  const route = state.routes.find((r) => r.id === Number($<HTMLSelectElement>("append-route").value));
  if (!route) {
    notify("Pick a route to append to.");
    return;
  }
  const added = state.selected.filter((id) => !route.poi_ids.includes(id));
  if (!added.length) {
    notify(`"${route.name}" already has every selected bonus.`);
    return;
  }
  if (!(await confirmReplaceImported(route, "Adding stops"))) return;
  state.selected = [];
  expandedRoutes.add(route.id);
  setView("map");
  await setStops(route, [...route.poi_ids, ...added]);
  showRoute(state.routes.find((r) => r.id === route.id) ?? route);
  revealRoute(route.id);
}

// --- Bonuses table ----------------------------------------------------------

type SortKey = "name" | "score" | "state" | "stop" | "tags" | "routes" | "notes";
const SORT_KEY = "route-camp.bonus-sort";
const NUMERIC_SORT: SortKey[] = ["score", "stop", "routes"];
const UNTAGGED_FILTER = "\u0000untagged"; // the Tag filter's "Untagged" option; no tag can be named this

function loadSort(): { key: SortKey; descending: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as { key?: string; descending?: boolean } | null;
    const keys: SortKey[] = ["name", "score", "state", "stop", "tags", "routes", "notes"];
    const key = keys.find((k) => k === saved?.key);
    if (key) return { key, descending: Boolean(saved?.descending) };
  } catch {
    // Storage unavailable or unreadable: default sort.
  }
  return { key: "name", descending: false };
}

let bonusSort = loadSort();

function routeCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const route of state.routes) {
    for (const id of new Set(route.poi_ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// The POIs the filter box and tag picker let through.
function shownBonuses(): POI[] {
  const text = $<HTMLInputElement>("bonus-filter").value.trim().toLowerCase();
  const tag = $<HTMLSelectElement>("bonus-tag").value;
  return state.pois.filter((poi) => {
    if (tag === UNTAGGED_FILTER ? poi.tags.length > 0 : tag && !poi.tags.includes(tag)) return false;
    if (!text) return true;
    return [poi.name, poi.state ?? "", poi.notes ?? "", ...poi.tags].some((field) => field.toLowerCase().includes(text));
  });
}

function sortValue(poi: POI, key: SortKey, counts: Map<number, number>): string | number | null {
  switch (key) {
    case "score": return poi.score;
    case "routes": return counts.get(poi.id) ?? 0;
    case "state": return poi.state || null;
    case "stop": return poi.stop_minutes;
    case "tags": return poi.tags.join(", ") || null;
    case "notes": return poi.notes || null;
    default: return poi.name;
  }
}

function sortBonuses(pois: POI[], counts: Map<number, number>): POI[] {
  const { key, descending } = bonusSort;
  return pois.slice().sort((a, b) => {
    const x = sortValue(a, key, counts);
    const y = sortValue(b, key, counts);
    if (x === null || y === null) return Number(x === null) - Number(y === null); // blanks last
    const order = typeof x === "number" && typeof y === "number"
      ? x - y
      : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return (descending ? -order : order) || a.name.localeCompare(b.name);
  });
}

function renderTagFilter(): void {
  const picker = $<HTMLSelectElement>("bonus-tag");
  const current = picker.value;
  const tags = [...new Set(state.pois.flatMap((poi) => poi.tags))].sort();
  picker.replaceChildren(
    h("option", { value: "" }, "all tags"),
    ...tags.map((tag) => h("option", { value: tag }, tag)),
    h("option", { value: UNTAGGED_FILTER }, UNTAGGED),
  );
  picker.value = tags.includes(current) || current === UNTAGGED_FILTER ? current : "";
}

function renderBonuses(): void {
  renderTagFilter();
  const counts = routeCounts();
  const shown = sortBonuses(shownBonuses(), counts);
  $("bonus-total").textContent = `${selectionTotals()} · showing ${shown.length} of ${state.pois.length}`;

  for (const th of document.querySelectorAll<HTMLElement>("#bonus-table th[data-sort]")) {
    if (th.dataset.sort === bonusSort.key) th.setAttribute("aria-sort", bonusSort.descending ? "descending" : "ascending");
    else th.removeAttribute("aria-sort");
  }
  const shownIds = shown.map((poi) => poi.id);
  const allTicked = shownIds.length > 0 && shownIds.every((id) => state.selected.includes(id));
  const tickAll = h("input", {
    type: "checkbox",
    title: allTicked ? "Untick every bonus shown" : "Tick every bonus shown",
    checked: allTicked,
    onchange: () => tickShown(!allTicked),
  });
  document.querySelector("#bonus-table th.tick")?.replaceChildren(tickAll);

  const body = document.querySelector("#bonus-table tbody") as HTMLElement;
  body.replaceChildren(
    ...shown.map((poi) => {
      const order = state.selected.indexOf(poi.id) + 1;
      return h(
        "tr",
        { className: order ? "selected" : "" },
        h("td", { className: "tick" }, h("input", {
          type: "checkbox",
          checked: order > 0,
          "aria-label": `Select ${poi.name}`,
          onchange: () => toggleSelected(poi.id),
        })),
        h("td", {}, h("button", {
          className: "link",
          title: "Show on the map",
          onclick: () => {
            setView("map");
            map.flyTo({ center: [poi.lon, poi.lat], zoom: 12 });
          },
        }, poi.name), ...(order ? [h("span", { className: "order-badge", title: `Number ${order} in the selection` }, String(order))] : [])),
        h("td", { className: "num" }, poi.score == null ? "" : formatPoints(poi.score)),
        h("td", {}, poi.state ?? ""),
        h("td", { className: "num" }, stopMinutesButton(poi)),
        h("td", {}, ...poi.tags.map((tag) => h("span", { className: "tag-chip plain" }, tag))),
        h("td", { className: "num" }, String(counts.get(poi.id) ?? 0)),
        h("td", { className: "notes" }, poi.notes ?? ""),
      );
    }),
  );
  if (!shown.length) {
    body.append(h("tr", {}, h("td", { colSpan: 8, className: "hint" }, state.pois.length ? "No bonuses match the filter." : "No POIs yet. Import a rally CSV or a GPX file.")));
  }
}

// Ticks (after the current selection, in the table's order) or unticks every bonus the filter shows.
function tickShown(tick: boolean): void {
  const ids = sortBonuses(shownBonuses(), routeCounts()).map((poi) => poi.id);
  setSelectedOrder(tick
    ? [...state.selected, ...ids.filter((id) => !state.selected.includes(id))]
    : state.selected.filter((id) => !ids.includes(id)));
}

// --- Views: map or the Bonuses table ---------------------------------------

type View = "map" | "bonuses";
const VIEW_KEY = "route-camp.view";

function setView(view: View): void {
  const bonuses = view === "bonuses";
  $("bonuses-view").hidden = !bonuses;
  for (const id of ["sidebar", "sidebar-resizer", "map-view"]) $(id).hidden = bonuses;
  // The Selected card goes with the view: beside the table, or back in the sidebar.
  $(bonuses ? "bonus-side" : "selected-slot").append($("selected-card"));
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".view-tabs button")) {
    tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
  }
  if (!bonuses) map.resize(); // the map was hidden, so its size is stale
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not stored; the view still applies to this page view.
  }
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
      ? "The dashed orange line is the proposed route."
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
  // Rows are keyed by position, since a POI can be a stop more than once.
  const reorder = (keys: string[]) => run(() => setStops(route, keys.map((key) => route.poi_ids[Number(key)])));
  return h(
    "ol",
    { className: "route-stops" },
    ...route.poi_ids.map((poiId, index) => {
      const poi = state.pois.find((p) => p.id === poiId);
      const name = poi?.name ?? "(deleted POI)";
      const item: HTMLElement = h(
        "li",
        {},
        h("span", {
          className: "drag-handle",
          title: "Drag to move this stop",
          "aria-hidden": "true",
          onpointerdown: (event: PointerEvent) => startDrag(event, item, reorder),
        }, "⠿"),
        positionButton(index, route.poi_ids.length, name, (to) => setStops(route, moveTo(route.poi_ids, index, to))),
        poi
          ? h("span", {
              className: "name",
              title: poi.name,
              onclick: () => map.flyTo({ center: [poi.lon, poi.lat], zoom: 12 }),
            }, poi.name)
          : h("span", { className: "name meta" }, "(deleted POI)"),
        ...(poi ? [stopMinutesButton(poi, stopMinutesAt(route.poi_ids, index))] : []),
        h("button", { title: "Move stop up", disabled: index === 0, onclick: () => run(() => move(index, -1)) }, "↑"),
        h("button", { title: "Move stop down", disabled: index === last, onclick: () => run(() => move(index, 1)) }, "↓"),
        h("button", {
          title: "Remove this stop from the route",
          "aria-label": `Remove stop ${index + 1}: ${name}`,
          onclick: () => run(() => setStops(route, route.poi_ids.filter((_, i) => i !== index))),
        }, "×"),
      );
      item.dataset.key = String(index);
      return item;
    }),
  );
}

// Adds POIs to the end of an existing route: one picked from the list, or every ticked POI (in tick order,
// skipping ones already on the route). Move them with ↑ / ↓, then recalc.
function renderAddStops(route: Route): HTMLElement {
  const picker: HTMLSelectElement = h(
    "select",
    {
      className: "stop-picker",
      title: "Add a POI to the end of this route",
      onchange: () => {
        const poiId = Number(picker.value);
        picker.value = "";
        if (poiId) void run(() => setStops(route, [...route.poi_ids, poiId]));
      },
    },
    h("option", { value: "" }, "add a stop…"),
    ...state.pois
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((poi) => h("option", { value: String(poi.id) }, poi.name)),
  );
  const ticked = state.selected.filter((id) => !route.poi_ids.includes(id));
  return h(
    "div",
    { className: "add-stops" },
    picker,
    h("button", {
      title: "Add the POIs ticked in the POI list to the end of this route, in tick order",
      disabled: ticked.length === 0,
      onclick: () => run(() => setStops(route, [...route.poi_ids, ...ticked])),
    }, `add ticked (${ticked.length})`),
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
    { className: shown ? "route shown" : "route", "data-route-id": route.id },
    h(
      "div",
      { className: "route-head" },
      h("input", {
        type: "checkbox",
        title: "Tick to tag several routes at once",
        checked: state.selectedRoutes.includes(route.id),
        onchange: () => {
          state.selectedRoutes = state.selectedRoutes.includes(route.id)
            ? state.selectedRoutes.filter((id) => id !== route.id)
            : [...state.selectedRoutes, route.id];
        },
      }),
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
          : routeStats(route),
      ),
      h("button", {
        className: stale ? "recalc-route" : "",
        title: "Calculate the line through the stops in this order",
        onclick: () => run(() => calculate(route)),
      }, stale ? "recalc" : "calc"),
      h("button", {
        title: "Table of the stops: bonus, points, miles and arrival time, to print or keep open",
        onclick: () => showRouteTable(route.id),
      }, "table"),
      h("button", {
        title: "Review a shorter stop order before saving it",
        onclick: () => run(() => optimize(route)),
      }, "optimize"),
      h("a", { href: api.routeGpxUrl(route.id), download: "", title: "Export GPX" }, "GPX"),
      h("button", {
        title: "Add a tag to every POI that is a stop of this route",
        onclick: () => run(() => tagRouteStops(route)),
      }, "tag stops"),
      planPicker(route),
      h("button", {
        title: "Make a copy of this route (stops, tags and line) to change without losing the original",
        onclick: () => run(() => duplicate(route)),
      }, "duplicate"),
      h("button", {
        className: "danger",
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
    renderRouteTags(route),
    ...(expanded
      ? [
          renderStops(route),
          renderAddStops(route),
          h("p", { className: "hint stops-hint" }, "Drag ⠿ or click a stop's number to move it. The stops stay in this order; after a change, press recalc to draw the line through them."),
        ]
      : []),
  );
}

// Tags every POI on the route (each once, however often it is a stop). Undo takes the tag off only the
// POIs that did not already have it.
async function tagRouteStops(route: Route): Promise<void> {
  const pois = [...new Set(route.poi_ids)]
    .map((id) => state.pois.find((poi) => poi.id === id))
    .filter((poi): poi is POI => poi !== undefined);
  if (!pois.length) {
    notify(`"${route.name}" has no stops to tag.`);
    return;
  }
  const name = (await askText(`Tag all ${pois.length} POIs on "${route.name}" with:`, route.name.toLowerCase()))?.trim().toLowerCase();
  if (!name) return;
  const added = pois.filter((poi) => !poi.tags.includes(name));
  const tag = await api.createTag(name);
  await forEachPoi(added, (poi) => api.tagItem(tag.id, "poi", poi.id));
  await refresh();
  const already = pois.length - added.length;
  showUndo(
    `Tagged ${added.length} POI${added.length === 1 ? "" : "s"} on "${route.name}" with "${name}"` +
      (already ? ` (${already} already had it).` : "."),
    () =>
      run(async () => {
        await forEachPoi(added, (poi) => api.untagItem(tag.id, "poi", poi.id));
        await refresh();
      }),
  );
}

// A route's tags as chips: × removes one, "+ tag" adds one (comma-separated adds several) and keeps the rest.
function renderRouteTags(route: Route): HTMLElement {
  const save = (tags: string[]) =>
    run(async () => {
      await api.updateRoute(route.id, { tags });
      await refresh();
    });
  return h(
    "div",
    { className: "tag-chips" },
    ...route.tags.map((tag) =>
      h(
        "span",
        { className: "tag-chip" },
        tag,
        h("button", {
          title: `Remove the "${tag}" tag from this route`,
          "aria-label": `Remove tag ${tag}`,
          onclick: () => save(route.tags.filter((t) => t !== tag)),
        }, "×"),
      ),
    ),
    h("button", {
      className: "add-tag",
      title: "Add a tag to this route",
      onclick: () =>
        run(async () => {
          const added = await askTags([]);
          if (!added || added.length === 0) return;
          await save([...new Set([...route.tags, ...added.map((t) => t.toLowerCase())])]);
        }),
    }, "+ tag"),
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
            className: "danger",
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
  const [pois, routes, plans, settings] = await Promise.all([
    api.listPois(), api.listRoutes(), api.listPlans(), api.settings(),
  ]);
  defaultStopMinutes = settings.stop_minutes;
  startMinutes = settings.start_minutes;
  const stopInput = $<HTMLInputElement>("stop-minutes");
  if (document.activeElement !== stopInput) stopInput.value = String(defaultStopMinutes);
  state.pois = pois;
  state.routes = routes;
  state.plans = plans;
  state.selectedRoutes = state.selectedRoutes.filter((id) => routes.some((route) => route.id === id));
  renderPois();
  renderRoutes();
  renderPlans();
  renderMarkers();
  renderSelected();
  renderBonuses();
}

// --- Wire up controls -------------------------------------------------------

const stopMinutesInput = $<HTMLInputElement>("stop-minutes");
stopMinutesInput.onchange = () =>
  run(async () => {
    const minutes = Number(stopMinutesInput.value);
    if (stopMinutesInput.value.trim() === "" || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      stopMinutesInput.value = String(defaultStopMinutes);
      notify("Minutes at each stop is a number from 0 to 1440.");
      return;
    }
    await api.updateSettings({ stop_minutes: minutes });
    await refresh();
  });

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

// Tags or untags the ticked routes with the name typed beside the buttons.
async function tagSelectedRoutes(add: boolean): Promise<void> {
  const input = $<HTMLInputElement>("route-tag-input");
  const name = input.value.trim();
  if (!name || state.selectedRoutes.length === 0) {
    notify("Type a tag name and tick at least one route.");
    return;
  }
  if (add) {
    const tag = await api.createTag(name);
    for (const id of state.selectedRoutes) await api.tagItem(tag.id, "route", id);
  } else {
    const tag = (await api.listTags()).find((t) => t.name === name.toLowerCase());
    if (tag) for (const id of state.selectedRoutes) await api.untagItem(tag.id, "route", id);
  }
  input.value = "";
  await refresh();
}

$("route-tag-selected").onclick = () => run(() => tagSelectedRoutes(true));
$("route-untag-selected").onclick = () => run(() => tagSelectedRoutes(false));

$("route-create").onclick = () => run(createRouteFromSelection);
$("append-selected").onclick = () => run(appendSelectionToRoute);
$("selected-clear").onclick = () => setSelectedOrder([]);
$("paste-set").onclick = () => applyBonusList(true);
$("paste-add").onclick = () => applyBonusList(false);

for (const tab of document.querySelectorAll<HTMLButtonElement>(".view-tabs button")) {
  tab.onclick = () => setView(tab.dataset.view === "bonuses" ? "bonuses" : "map");
}
$("bonus-filter").oninput = renderBonuses;
$("bonus-tag").onchange = renderBonuses;
$("bonus-tick-shown").onclick = () => tickShown(true);
$("bonus-untick-shown").onclick = () => tickShown(false);

// Click a heading to sort by it; again to reverse. Numbers sort highest first, text A to Z; blanks last.
for (const th of document.querySelectorAll<HTMLElement>("#bonus-table th[data-sort]")) {
  const key = th.dataset.sort as SortKey;
  const sortBy = () => {
    bonusSort = bonusSort.key === key
      ? { key, descending: !bonusSort.descending }
      : { key, descending: NUMERIC_SORT.includes(key) };
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(bonusSort));
    } catch {
      // Not stored; the sort still applies to this page view.
    }
    renderBonuses();
  };
  th.tabIndex = 0;
  th.title = "Sort by this column";
  th.onclick = sortBy;
  th.onkeydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      sortBy();
    }
  };
}

try {
  if (localStorage.getItem(VIEW_KEY) === "bonuses") setView("bonuses");
} catch {
  // Storage unavailable: start on the map.
}

// Hides the drawn route and unticks POIs; nothing is deleted.
$("map-clear").onclick = () => {
  clearShownRoute();
  state.selected = [];
  state.selectedRoutes = [];
  renderSelection();
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
      notify("Choose a .gpx or rally .csv file first.");
      return;
    }
    // A .csv is a rally bonus list (code, lat, lon, points, state); anything else is read as GPX.
    const rally = file.name.toLowerCase().endsWith(".csv");
    const message = rally ? rallyImportMessage(await api.importRally(file)) : importMessage(await api.importGpx(file));
    input.value = "";
    notify(message);
    await refresh();
  });

await run(refresh);
