import re

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_app_settings, get_or_404
from app.config import Settings
from app.database import get_session
from app.gpx import parse_gpx
from app.models import Route
from app.rally import RallyCsvError, parse_rally_csv
from app.schemas import ImportedRouteOut, ImportSummaryOut, RallyImportOut
from app.services import ImportSummary, export_route_gpx, import_gpx, import_rally_bonuses

router = APIRouter(tags=["gpx"])


@router.post("/gpx/import", response_model=ImportSummaryOut)
async def import_gpx_file(file: UploadFile, session: Session = Depends(get_session)):
    # TODO: move to a threadpool (plain def) if large files make the event loop stall.
    data = await file.read()
    try:
        parsed = parse_gpx(data)
    except Exception as exc:  # gpxpy raises several types for malformed XML
        raise HTTPException(status_code=422, detail=f"Invalid GPX: {exc}") from exc
    summary = import_gpx(session, parsed)
    session.commit()
    return _summary_out(summary)


@router.post("/rally/import", response_model=RallyImportOut, tags=["rally"])
async def import_rally_csv(file: UploadFile, session: Session = Depends(get_session)):
    """Rally bonus CSV (code, lat, lon, points, state). Matches existing POIs; reports created vs matched."""
    data = await file.read()
    try:
        bonuses = parse_rally_csv(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, RallyCsvError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid rally CSV: {exc}") from exc
    summary = import_rally_bonuses(session, bonuses)
    session.commit()
    return RallyImportOut(
        bonuses=summary.bonuses,
        pois_created=len(summary.created),
        pois_matched=summary.matched,
        pois_updated=len(summary.updated),
        created=summary.created,
        updated=summary.updated,
    )


def _summary_out(summary: ImportSummary) -> ImportSummaryOut:
    return ImportSummaryOut(
        pois_created=summary.pois_created,
        pois_matched=summary.pois_matched,
        routes_created=sum(r.status == "created" for r in summary.routes),
        routes_matched=sum(r.status == "matched" for r in summary.routes),
        routes=[ImportedRouteOut(**vars(r)) for r in summary.routes],
    )


@router.get("/routes/{route_id}/gpx")
def export_route(
    route_id: int,
    shaping_km: float | None = None,
    track: bool = True,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_app_settings),
):
    """shaping_km overrides the configured shaping-point spacing for this download; 0 leaves them out.
    track=false leaves out the cached line, for a GPS."""
    route = get_or_404(session, Route, route_id)
    spacing_km = settings.shaping_spacing_km if shaping_km is None else shaping_km
    filename = re.sub(r"[^A-Za-z0-9_-]+", "-", route.name).strip("-") or "route"
    return Response(
        content=export_route_gpx(route, spacing_km * 1000, settings.max_route_points, track),
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}.gpx"'},
    )
