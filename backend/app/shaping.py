# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 15:57:09 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 5f93c30 | Export Garmin shaping points along the route line
# END LICENSE HEADER
"""Shaping points for Garmin export.

A Garmin recalculates a trip between its route points on its own maps. Extra shaping points taken from
the calculated line (points the device routes through without announcing them as stops) keep that
recalculation on the planned roads. Points are (lat, lon) tuples.
"""

from app.geo import haversine_m

SPACING_GROWTH = 1.25  # spacing is widened by this factor until the point budget is met


def _stop_indices(line: list[tuple[float, float]], stops: list[tuple[float, float]]) -> list[int]:
    """Index of the line vertex nearest each stop, never going backwards along the line."""
    indices = []
    start = 0
    for stop in stops:
        best = min(range(start, len(line)), key=lambda i: haversine_m(line[i], stop))
        indices.append(best)
        start = best
    return indices


def _leg_points(line: list[tuple[float, float]], first: int, last: int, spacing_m: float) -> list[tuple[float, float]]:
    """Line vertices roughly every spacing_m between two stops, none closer than half a spacing to either end."""
    remaining = sum(haversine_m(a, b) for a, b in zip(line[first:last], line[first + 1 : last + 1]))
    points = []
    since_last = 0.0
    for i in range(first + 1, last):
        step = haversine_m(line[i - 1], line[i])
        since_last += step
        remaining -= step
        if since_last >= spacing_m and remaining >= spacing_m / 2:
            points.append(line[i])
            since_last = 0.0
    return points


def shaping_points(
    line: list[tuple[float, float]],
    stops: list[tuple[float, float]],
    spacing_m: float,
    max_route_points: int,
) -> list[list[tuple[float, float]]]:
    """Shaping points for each leg (len(stops) - 1 lists), taken from the line's own vertices so they sit on the road.

    The spacing grows until stops plus shaping points fit in max_route_points. Returns empty legs when
    spacing is off (<= 0), the line is too short, or the stops alone use the whole budget.
    """
    legs = max(len(stops) - 1, 0)
    budget = max_route_points - len(stops)
    if spacing_m <= 0 or legs == 0 or len(line) < 3 or budget <= 0:
        return [[] for _ in range(legs)]
    indices = _stop_indices(line, stops)
    while True:
        result = [_leg_points(line, a, b, spacing_m) for a, b in zip(indices, indices[1:])]
        if sum(len(points) for points in result) <= budget:
            return result
        spacing_m *= SPACING_GROWTH
