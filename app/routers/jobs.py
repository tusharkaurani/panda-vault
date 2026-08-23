"""The scan/rebuild job feed the UI polls.

Lives on its own prefix rather than under /api/channels because jobs now
span every source type — a playlist scan and a channel scan are the same
kind of thing to the notification bell — and because /api/channels is
gated on a live Telegram session, which an M3U-only install doesn't have.
"""
from fastapi import APIRouter

from .. import jobs

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs():
    return {"jobs": jobs.all_jobs()}
