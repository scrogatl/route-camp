export type Profile = "car" | "fun";
export type ItemKind = "poi" | "route" | "plan";
export type LonLat = [number, number];

export interface POI {
  id: number;
  name: string;
  lat: number;
  lon: number;
  notes: string | null;
  score: number | null;
  state: string | null; // e.g. "GA", from a rally CSV
  stop_minutes: number | null; // minutes at this stop; null means the default
  tags: string[];
}

export interface RouteLeg {
  distance_m: number;
  time_s: number; // driving time
}

export interface Route {
  id: number;
  name: string;
  notes: string | null;
  profile: Profile;
  poi_ids: number[];
  distance_m: number | null;
  time_s: number | null; // driving time
  stop_s: number; // time at the stops (not the first or last unless they have their own minutes)
  total_s: number | null; // driving plus stops; null without a driving time
  geometry: LonLat[] | null;
  geometry_source: "calculated" | "imported" | null;
  legs: RouteLeg[] | null; // one per pair of consecutive stops; null until calculated, or for a GPX track
  tags: string[];
}

export interface Plan {
  id: number;
  name: string;
  notes: string | null;
  route_ids: number[];
  tags: string[];
  distance_m: number;
  time_s: number; // driving time
  stop_s: number;
  total_s: number;
  routes_total: number;
  routes_with_distance: number;
  routes_with_time: number;
}

export interface AppSettings {
  stop_minutes: number; // default minutes at each stop
  start_minutes: number; // rally start, minutes after midnight
}

export interface OrderSummary {
  poi_ids: number[];
  distance_m: number | null;
  time_s: number | null;
}

// A proposed stop order from the optimize preview. Nothing is saved until the user accepts it.
export interface OptimizePreview {
  source: "graphhopper" | "haversine" | "none";
  current: OrderSummary;
  proposed: OrderSummary;
  geometry: LonLat[] | null;
}

export interface Tag {
  id: number;
  name: string;
}

export interface ClientConfig {
  map_style_url: string;
  routing_profiles: Profile[];
}

export interface ImportedRoute {
  id: number;
  name: string;
  kind: "route" | "track";
  status: "created" | "matched";
}

export interface ImportSummary {
  pois_created: number;
  pois_matched: number;
  routes_created: number;
  routes_matched: number;
  routes: ImportedRoute[];
}

export interface RallyImportSummary {
  bonuses: number;
  pois_created: number;
  pois_matched: number;
  pois_updated: number;
  created: string[];
  updated: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
  });
  if (!response.ok) {
    throw new ApiError(response.status, `${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  config: () => request<ClientConfig>("/config"),

  listPois: () => request<POI[]>("/pois"),
  createPoi: (poi: { name: string; lat: number; lon: number; tags?: string[] }) =>
    request<POI>("/pois", send("POST", poi)),
  settings: () => request<AppSettings>("/settings"),
  updateSettings: (patch: Partial<AppSettings>) => request<AppSettings>("/settings", send("PATCH", patch)),
  updatePoi: (id: number, patch: Partial<Pick<POI, "score" | "stop_minutes">>) => request<POI>(`/pois/${id}`, send("PATCH", patch)),
  deletePoi: (id: number) => request<void>(`/pois/${id}`, send("DELETE")),

  listRoutes: () => request<Route[]>("/routes"),
  createRoute: (route: { name: string; profile: Profile; poi_ids: number[] }) =>
    request<Route>("/routes", send("POST", route)),
  updateRoute: (id: number, patch: Partial<Pick<Route, "name" | "tags" | "poi_ids">>) =>
    request<Route>(`/routes/${id}`, send("PATCH", patch)),
  duplicateRoute: (id: number, name: string) => request<Route>(`/routes/${id}/duplicate`, send("POST", { name })),
  deleteRoute: (id: number) => request<void>(`/routes/${id}`, send("DELETE")),
  calculateRoute: (id: number, replaceImported: boolean) =>
    request<Route>(`/routes/${id}/calculate?replace_imported=${replaceImported}`, send("POST")),
  previewOptimize: (id: number, replaceImported: boolean) =>
    request<OptimizePreview>(`/routes/${id}/optimize-preview?replace_imported=${replaceImported}`, send("POST")),
  optimizeRoute: (id: number, replaceImported: boolean) =>
    request<{ route: Route; source: string }>(`/routes/${id}/optimize?replace_imported=${replaceImported}`, send("POST")),
  routeGpxUrl: (id: number, track = false) => `/api/routes/${id}/gpx?track=${track}`,

  listPlans: () => request<Plan[]>("/plans"),
  createPlan: (plan: { name: string; route_ids?: number[]; tags?: string[] }) =>
    request<Plan>("/plans", send("POST", plan)),
  updatePlan: (id: number, patch: Partial<Pick<Plan, "name" | "route_ids" | "tags">>) =>
    request<Plan>(`/plans/${id}`, send("PATCH", patch)),
  deletePlan: (id: number) => request<void>(`/plans/${id}`, send("DELETE")),

  listTags: () => request<Tag[]>("/tags"),
  createTag: (name: string) => request<Tag>("/tags", send("POST", { name })),
  tagItem: (tagId: number, kind: ItemKind, id: number) =>
    request<void>(`/tags/${tagId}/items`, send("POST", { kind, id })),
  untagItem: (tagId: number, kind: ItemKind, id: number) =>
    request<void>(`/tags/${tagId}/items/${kind}/${id}`, send("DELETE")),

  importGpx: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<ImportSummary>("/gpx/import", { method: "POST", body });
  },
  importRally: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<RallyImportSummary>("/rally/import", { method: "POST", body });
  },
};
