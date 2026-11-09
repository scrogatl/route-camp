# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 16:30:44 -0500 | Scott Rogers <scott@scottandrewrogers.com> | fdd43dc | Add a nullable POI score, filled from names
# END LICENSE HEADER
"""POI scores: a number at the end of a name, such as "TALU 669" -> 669.

Scores are filled from names in two places: GPX import (new POIs only) and the one-off backfill
command (`python -m app.backfill_scores`), which fills only POIs whose score is still empty. The
backfill never runs at startup, so a score the user cleared stays cleared.
"""

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import POI

_TRAILING_NUMBER = re.compile(r" (\d{1,9})$")


def parse_score(name: str) -> int | None:
    match = _TRAILING_NUMBER.search(name)
    return int(match.group(1)) if match else None


def backfill_scores(session: Session) -> int:
    """Fill null scores from names. Returns how many POIs were filled."""
    filled = 0
    for poi in session.scalars(select(POI).where(POI.score.is_(None))):
        score = parse_score(poi.name)
        if score is not None:
            poi.score = score
            filled += 1
    session.flush()
    return filled
