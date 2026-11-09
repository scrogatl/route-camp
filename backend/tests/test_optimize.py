# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 42f2690 | Add REST API, GraphHopper routing and stop optimization
# END LICENSE HEADER
from app.optimize import best_order, haversine_time_matrix, path_cost


def test_best_order_walks_a_line_from_the_fixed_start():
    # Four stops on one meridian, listed out of order: start at 0deg, then 1deg, 2deg, 3deg.
    points = [(0.0, 0.0), (0.0, 3.0), (0.0, 1.0), (0.0, 2.0)]
    matrix = haversine_time_matrix(points)
    order = best_order(matrix)
    assert order == [0, 2, 3, 1]
    assert path_cost(order, matrix) <= path_cost([0, 1, 2, 3], matrix)


def test_short_routes_are_left_alone():
    assert best_order([[0.0, 1.0], [1.0, 0.0]]) == [0, 1]
    assert best_order([[0.0]]) == [0]
