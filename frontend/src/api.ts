export type Profile = "car" | "fun";
export type ItemKind = "poi" | "route" | "plan";
export type LonLat = [number, number];

export interface POI {
  id: number;
  name: string;
  lat: number;
  lon: number;
  notes: string | null;
  tags: string[];
}

export interface Route {
  id: number;
  name: string;
  notes: string | null;
  profile: Profile;
  poi_ids: number[];
  distance_m: number | null;
  time_s: number | null;
  geometry: LonLat[] | null;
  geometry_source: "calculated" | "imported" | null;
  tags: string[];
}

export interface Plan {
  id: number;
  name: string;
  notes: string | null;
  route_ids: number[];
  tags: string[];
  distance_m: number;
  time_s: number;
  routes_total: number;
  routes_with_distance: number;
  routes_with_time: number;
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
  deletePoi: (id: number) => request<void>(`/pois/${id}`, send("DELETE")),

  listRoutes: () => request<Route[]>("/routes"),
  createRoute: (route: { name: string; profile: Profile; poi_ids: number[] }) =>
    request<Route>("/routes", send("POST", route)),
  updateRoute: (id: number, patch: Partial<Pick<Route, "tags">>) => request<Route>(`/routes/${id}`, send("PATCH", patch)),
  deleteRoute: (id: number) => request<void>(`/routes/${id}`, send("DELETE")),
  calculateRoute: (id: number, replaceImported: boolean) =>
    request<Route>(`/routes/${id}/calculate?replace_imported=${replaceImported}`, send("POST")),
  optimizeRoute: (id: number, replaceImported: boolean) =>
    request<{ route: Route; source: string }>(`/routes/${id}/optimize?replace_imported=${replaceImported}`, send("POST")),
  routeGpxUrl: (id: number) => `/api/routes/${id}/gpx`,

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
};
