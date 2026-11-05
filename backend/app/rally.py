"""Rally bonus CSV, as used by rally-route-finder (bonus-lat-lon-points.csv).

No header; one bonus per line: ``code, lat, lon, points, state, , `` (trailing fields unused),
e.g. ``ABAC, 31.48, -83.52,510, GA, , ``. A state of "N/A" or blank means none.
"""

import csv
import io
from dataclasses import dataclass

NO_STATE = {"", "N/A", "NA", "-"}


@dataclass
class RallyBonus:
    code: str
    lat: float
    lon: float
    points: int
    state: str | None


class RallyCsvError(ValueError):
    pass


def parse_rally_csv(text: str) -> list[RallyBonus]:
    bonuses: list[RallyBonus] = []
    for line_no, row in enumerate(csv.reader(io.StringIO(text)), start=1):
        fields = [f.strip() for f in row]
        if not any(fields):
            continue  # blank line
        if len(fields) < 4:
            raise RallyCsvError(f"line {line_no}: expected code, lat, lon, points; got {len(fields)} fields")
        code, lat, lon, points = fields[:4]
        state = fields[4] if len(fields) > 4 else ""
        try:
            lat_f, lon_f = float(lat), float(lon)
        except ValueError:
            if line_no == 1 and lat.lower().startswith("lat"):
                continue  # a header row, if a file has one
            raise RallyCsvError(f"line {line_no}: lat and lon must be numbers") from None
        try:
            points_i = int(float(points))
        except ValueError:
            raise RallyCsvError(f"line {line_no}: points must be a number") from None
        if not code:
            raise RallyCsvError(f"line {line_no}: missing bonus code")
        if not (-90 <= lat_f <= 90 and -180 <= lon_f <= 180) or points_i < 0:
            raise RallyCsvError(f"line {line_no}: lat, lon or points out of range")
        bonuses.append(RallyBonus(code, lat_f, lon_f, points_i, None if state.upper() in NO_STATE else state))
    return bonuses
