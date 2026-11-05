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
  tags: string[];
}

export interface Tag {
  id: number;
  name: string;
}

export interface ClientConfig {
  map_style_url: string;
  routing_profiles: Profile[];
}

export interface ImportSummary {
  pois_created: number;
  pois_matched: number;
  routes_created: number;
  tracks_skipped: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  config: () => request<ClientConfig>("/config"),

  listPois: (tag: string) => request<POI[]>(`/pois${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`),
  createPoi: (poi: { name: string; lat: number; lon: number; tags?: string[] }) =>
    request<POI>("/pois", json(poi)),
  deletePoi: (id: number) => request<void>(`/pois/${id}`, { method: "DELETE" }),

  listRoutes: () => request<Route[]>("/routes"),
  createRoute: (route: { name: string; profile: Profile; poi_ids: number[] }) =>
    request<Route>("/routes", json(route)),
  deleteRoute: (id: number) => request<void>(`/routes/${id}`, { method: "DELETE" }),
  calculateRoute: (id: number) => request<Route>(`/routes/${id}/calculate`, { method: "POST" }),
  optimizeRoute: (id: number) =>
    request<{ route: Route; source: string }>(`/routes/${id}/optimize`, { method: "POST" }),
  routeGpxUrl: (id: number) => `/api/routes/${id}/gpx`,

  listTags: () => request<Tag[]>("/tags"),
  createTag: (name: string) => request<Tag>("/tags", json({ name })),
  tagItem: (tagId: number, kind: ItemKind, id: number) => request<void>(`/tags/${tagId}/items`, json({ kind, id })),

  importGpx: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<ImportSummary>("/gpx/import", { method: "POST", body });
  },
};
