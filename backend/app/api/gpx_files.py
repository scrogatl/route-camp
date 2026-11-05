import re
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_or_404
from app.database import get_session
from app.gpx import parse_gpx
from app.models import Route
from app.schemas import ImportSummaryOut
from app.services import export_route_gpx, import_gpx

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
    return ImportSummaryOut(**asdict(summary))


@router.get("/routes/{route_id}/gpx")
def export_route(route_id: int, session: Session = Depends(get_session)):
    route = get_or_404(session, Route, route_id)
    filename = re.sub(r"[^A-Za-z0-9_-]+", "-", route.name).strip("-") or "route"
    return Response(
        content=export_route_gpx(route),
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}.gpx"'},
    )
