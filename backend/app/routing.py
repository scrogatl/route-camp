# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-06 10:59:13 -0500 | Scott Rogers <scott@scottandrewrogers.com> | f9b12e3 | Duplicate a route, and a route table with arrival times
#   2026-11-05 13:19:21 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 20a0a63 | Build optimize travel-time matrix from pairwise route calls
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 42f2690 | Add REST API, GraphHopper routing and stop optimization
# END LICENSE HEADER
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
    legs: list[dict]  # one {"distance_m", "time_s"} per pair of consecutive points


# Instruction signs that end a leg: a via point reached, and the destination.
_LEG_END_SIGNS = (5, 4)


def split_legs(instructions: list[dict], points: int) -> list[dict]:
    """Per-leg distance and time from GraphHopper's turn instructions, which mark each via point reached."""
    legs = [{"distance_m": 0.0, "time_s": 0.0}]
    for instruction in instructions:
        legs[-1]["distance_m"] += instruction["distance"]
        legs[-1]["time_s"] += instruction["time"] / 1000.0
        if instruction["sign"] in _LEG_END_SIGNS and len(legs) < points - 1:
            legs.append({"distance_m": 0.0, "time_s": 0.0})
    return legs


class GraphHopperClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self._http = httpx.Client(base_url=base_url, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def route(self, points: list[list[float]], profile: str) -> RouteResult:
        """points are [lon, lat] in visiting order."""
        path = self._post_route(points, profile, calc_points=True, instructions=True)
        return RouteResult(
            geometry=path["points"]["coordinates"],
            distance_m=path["distance"],
            time_s=path["time"] / 1000.0,
            legs=split_legs(path.get("instructions", []), len(points)),
        )

    def matrix(self, points: list[list[float]], profile: str) -> list[list[float]]:
        """Travel time in seconds between every pair of points (inf where no route exists).

        The GraphHopper build used here has no /matrix endpoint, so this makes one /route call per pair.
        That is O(n^2) requests, fine for the stop counts of a single trip.
        TODO: use GraphHopper's matrix API once the server exposes it, to cut the request count.
        """
        n = len(points)
        times = [[0.0 if i == j else math.inf for j in range(n)] for i in range(n)]
        reachable = 0
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                try:
                    times[i][j] = self._post_route([points[i], points[j]], profile, calc_points=False)["time"] / 1000.0
                    reachable += 1
                except RoutingError:
                    pass  # stays inf: that leg cannot be driven
        if n > 1 and reachable == 0:
            raise RoutingError("GraphHopper found no drivable legs between the stops")
        return times

    def _post_route(self, points: list[list[float]], profile: str, calc_points: bool, instructions: bool = False) -> dict:
        body = {
            "points": points,
            "profile": profile,
            "points_encoded": False,
            "instructions": instructions,
            "calc_points": calc_points,
        }
        return self._post("/route", body)["paths"][0]

    def _post(self, path: str, body: dict) -> dict:
        try:
            response = self._http.post(path, json=body)
        except httpx.HTTPError as exc:
            raise RoutingError(f"GraphHopper unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise RoutingError(f"GraphHopper error {response.status_code}: {response.text[:300]}")
        return response.json()
