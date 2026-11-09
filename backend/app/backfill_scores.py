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
"""One-off: fill empty POI scores from names. Safe to re-run; it only touches POIs with no score.

    docker compose exec backend python -m app.backfill_scores
"""

from sqlalchemy.orm import Session

from app import database
from app.config import get_settings
from app.scores import backfill_scores


def main() -> None:
    engine = database.configure(get_settings().database_url)
    with Session(engine) as session:
        filled = backfill_scores(session)
        session.commit()
    print(f"Filled {filled} POI scores from names.")


if __name__ == "__main__":
    main()
