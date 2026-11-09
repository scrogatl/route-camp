# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:50:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | e0f6e37 | Import GPX tracks as routes, de-duplicate re-imports, guard imported lines
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 42f2690 | Add REST API, GraphHopper routing and stop optimization
# END LICENSE HEADER
"""Stop ordering for a route.

Keeps the first stop fixed as the start and orders the rest with nearest-neighbour followed by 2-opt.
TODO: swap for OR-Tools or VROOM when we need time windows, multiple vehicles or a return-to-start leg.
"""

import math

from app.geo import haversine_m

FALLBACK_SPEED_MPS = 13.9  # ~50 km/h, used only when GraphHopper is unavailable


def haversine_time_matrix(points: list[tuple[float, float]]) -> list[list[float]]:
    return [[haversine_m(a, b) / FALLBACK_SPEED_MPS for b in points] for a in points]


def path_cost(order: list[int], matrix: list[list[float]]) -> float:
    return sum(matrix[a][b] for a, b in zip(order, order[1:]))


def best_order(matrix: list[list[float]]) -> list[int]:
    n = len(matrix)
    if n <= 2:
        return list(range(n))

    unvisited = set(range(1, n))
    order = [0]
    while unvisited:
        nearest = min(unvisited, key=lambda j: matrix[order[-1]][j])
        order.append(nearest)
        unvisited.remove(nearest)

    improved = True
    while improved:
        improved = False
        for i in range(1, n - 1):
            for k in range(i + 1, n):
                candidate = order[:i] + order[i : k + 1][::-1] + order[k + 1 :]
                if path_cost(candidate, matrix) + 1e-9 < path_cost(order, matrix):
                    order = candidate
                    improved = True
    return order
