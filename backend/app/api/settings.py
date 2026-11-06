from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_session
from app.schemas import SettingsOut, SettingsUpdate
from app.stop_time import default_stop_minutes, set_default_stop_minutes

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=SettingsOut)
def get_settings(session: Session = Depends(get_session)):
    return SettingsOut(stop_minutes=default_stop_minutes(session))


@router.patch("", response_model=SettingsOut)
def update_settings(payload: SettingsUpdate, session: Session = Depends(get_session)):
    if payload.stop_minutes is not None:
        set_default_stop_minutes(session, payload.stop_minutes)
        session.commit()
    return SettingsOut(stop_minutes=default_stop_minutes(session))
