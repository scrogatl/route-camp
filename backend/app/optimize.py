"""Stop ordering for a route.

Keeps the first stop fixed as the start and orders the rest with nearest-neighbour followed by 2-opt.
TODO: swap for OR-Tools or VROOM when we need time windows, multiple vehicles or a return-to-start leg.
"""

import math

EARTH_RADIUS_M = 6_371_000.0
FALLBACK_SPEED_MPS = 13.9  # ~50 km/h, used only when GraphHopper's matrix endpoint is unavailable


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between (lat, lon) pairs."""
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


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
