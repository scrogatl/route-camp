from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_session
from app.models import AppSetting
from app.schemas import SettingsOut, SettingsUpdate
from app.stop_time import default_stop_minutes, set_default_stop_minutes

router = APIRouter(prefix="/settings", tags=["settings"])

DEFAULT_START_MINUTES = 8 * 60.0  # 08:00, until the user sets the rally start


def _start_minutes(session: Session) -> float:
    setting = session.get(AppSetting, "start_minutes")
    return DEFAULT_START_MINUTES if setting is None or setting.value is None else setting.value


def _settings(session: Session) -> SettingsOut:
    return SettingsOut(stop_minutes=default_stop_minutes(session), start_minutes=_start_minutes(session))


@router.get("", response_model=SettingsOut)
def get_settings(session: Session = Depends(get_session)):
    return _settings(session)


@router.patch("", response_model=SettingsOut)
def update_settings(payload: SettingsUpdate, session: Session = Depends(get_session)):
    if payload.stop_minutes is not None:
        set_default_stop_minutes(session, payload.stop_minutes)
    if payload.start_minutes is not None:
        session.merge(AppSetting(key="start_minutes", value=payload.start_minutes))
    session.commit()
    return _settings(session)
