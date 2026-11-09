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
# END LICENSE HEADER
from app.routing import split_legs


def _instruction(sign, distance, time_ms):
    return {"sign": sign, "distance": distance, "time": time_ms}


def test_split_legs_ends_a_leg_at_each_via_point_and_the_destination():
    instructions = [
        _instruction(0, 1000, 60_000),
        _instruction(5, 0, 0),  # via point 1 reached
        _instruction(2, 500, 30_000),
        _instruction(5, 0, 0),  # via point 2 reached
        _instruction(0, 2000, 90_000),
        _instruction(4, 0, 0),  # destination
    ]
    assert split_legs(instructions, 4) == [
        {"distance_m": 1000, "time_s": 60},
        {"distance_m": 500, "time_s": 30},
        {"distance_m": 2000, "time_s": 90},
    ]


def test_split_legs_with_two_points_is_one_leg():
    assert split_legs([_instruction(0, 800, 40_000), _instruction(4, 0, 0)], 2) == [{"distance_m": 800, "time_s": 40}]
