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
# END LICENSE HEADER
from app.geo import MAX_TRACK_POINTS, path_length_m, simplify


def test_simplify_keeps_short_lines_untouched():
    points = [(34.5, -83.5), (34.6, -83.4)]
    assert simplify(points) == points


def test_simplify_caps_long_noisy_tracks_and_keeps_endpoints():
    # 6000 points along a line with a 2 m zig-zag: most of them carry no shape.
    points = [(34.5 + i * 1e-5, -83.5 + (0.00002 if i % 2 else 0)) for i in range(6000)]
    simplified = simplify(points)
    assert len(simplified) <= MAX_TRACK_POINTS
    assert simplified[0] == points[0] and simplified[-1] == points[-1]


def test_simplify_keeps_a_real_corner():
    corner = [(0.0, 0.0), (0.0, 0.001), (0.0, 0.002), (0.001, 0.002), (0.002, 0.002)]
    assert (0.0, 0.002) in simplify(corner, max_points=3)


def test_path_length_is_roughly_right():
    # One degree of latitude is about 111 km.
    assert abs(path_length_m([(0.0, 0.0), (1.0, 0.0)]) - 111_195) < 500
