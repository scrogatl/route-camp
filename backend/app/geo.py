"""Geometry helpers. Points are (lat, lon) tuples unless noted."""

import math

EARTH_RADIUS_M = 6_371_000.0
METRES_PER_DEG_LAT = 110_574.0
METRES_PER_DEG_LON_EQUATOR = 111_320.0
MAX_TRACK_POINTS = 2000  # imported tracks are simplified to at most this many points


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres."""
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def path_length_m(points: list[tuple[float, float]]) -> float:
    return sum(haversine_m(a, b) for a, b in zip(points, points[1:]))


def _project(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Equirectangular projection to metres. Accurate enough for simplification tolerances."""
    mean_lat = sum(lat for lat, _ in points) / len(points)
    scale_x = METRES_PER_DEG_LON_EQUATOR * math.cos(math.radians(mean_lat))
    return [(lon * scale_x, lat * METRES_PER_DEG_LAT) for lat, lon in points]


def _perpendicular_distance(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    if length == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    return abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / length


def _douglas_peucker(xy: list[tuple[float, float]], tolerance: float) -> list[int]:
    """Indices of the points kept. Iterative so long tracks cannot hit the recursion limit."""
    keep = [False] * len(xy)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        worst, worst_distance = first, -1.0
        for k in range(first + 1, last):
            distance = _perpendicular_distance(xy[k], xy[first], xy[last])
            if distance > worst_distance:
                worst, worst_distance = k, distance
        if worst_distance > tolerance:
            keep[worst] = True
            stack.append((first, worst))
            stack.append((worst, last))
    return [i for i, kept in enumerate(keep) if kept]


def simplify(points: list[tuple[float, float]], max_points: int = MAX_TRACK_POINTS) -> list[tuple[float, float]]:
    """Douglas-Peucker simplification. The tolerance grows until the result has at most max_points points.

    The first and last points are always kept.
    """
    if len(points) <= max_points or max_points < 2:
        return list(points)
    xy = _project(points)
    tolerance = 1.0  # metres
    while True:
        kept = _douglas_peucker(xy, tolerance)
        if len(kept) <= max_points:
            return [points[i] for i in kept]
        tolerance *= 1.5
