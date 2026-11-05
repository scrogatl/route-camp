import re

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_or_404
from app.database import get_session
from app.gpx import parse_gpx
from app.models import Route
from app.schemas import ImportedRouteOut, ImportSummaryOut
from app.services import ImportSummary, export_route_gpx, import_gpx

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


def _summary_out(summary: ImportSummary) -> ImportSummaryOut:
    return ImportSummaryOut(
        pois_created=summary.pois_created,
        pois_matched=summary.pois_matched,
        routes_created=sum(r.status == "created" for r in summary.routes),
        routes_matched=sum(r.status == "matched" for r in summary.routes),
        routes=[ImportedRouteOut(**vars(r)) for r in summary.routes],
    )


@router.get("/routes/{route_id}/gpx")
def export_route(route_id: int, session: Session = Depends(get_session)):
    route = get_or_404(session, Route, route_id)
    filename = re.sub(r"[^A-Za-z0-9_-]+", "-", route.name).strip("-") or "route"
    return Response(
        content=export_route_gpx(route),
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}.gpx"'},
    )
