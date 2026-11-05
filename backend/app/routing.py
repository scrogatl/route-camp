"""Thin client for GraphHopper's HTTP API (https://docs.graphhopper.com/)."""

import math
from dataclasses import dataclass

import httpx


class RoutingError(Exception):
    """GraphHopper is unreachable or returned an error."""


@dataclass
class RouteResult:
    geometry: list[list[float]]  # [[lon, lat], ...]
    distance_m: float
    time_s: float


class GraphHopperClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self._http = httpx.Client(base_url=base_url, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def route(self, points: list[list[float]], profile: str) -> RouteResult:
        """points are [lon, lat] in visiting order."""
        body = {
            "points": points,
            "profile": profile,
            "points_encoded": False,
            "instructions": False,
            "calc_points": True,
        }
        path = self._post("/route", body)["paths"][0]
        return RouteResult(
            geometry=path["points"]["coordinates"],
            distance_m=path["distance"],
            time_s=path["time"] / 1000.0,
        )

    def matrix(self, points: list[list[float]], profile: str) -> list[list[float]]:
        """Travel time in seconds between every pair of points. Unreachable pairs come back as inf."""
        body = {"from_points": points, "to_points": points, "profile": profile, "out_arrays": ["times"]}
        times = self._post("/matrix", body)["times"]
        return [[math.inf if value is None else value for value in row] for row in times]

    def _post(self, path: str, body: dict) -> dict:
        try:
            response = self._http.post(path, json=body)
        except httpx.HTTPError as exc:
            raise RoutingError(f"GraphHopper unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise RoutingError(f"GraphHopper error {response.status_code}: {response.text[:300]}")
        return response.json()
