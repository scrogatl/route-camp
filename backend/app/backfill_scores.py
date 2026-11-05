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
