"""
Panda Vault — organizes resources from several kinds of source (Telegram
channels, M3U playlists) into per-source collection trees, with a
card-based UI for browsing and an in-app Settings screen for managing
integrations, sources and collections. The built React/Tailwind SPA
(frontend/dist, copied to ./static in the Docker image) is served
straight off this FastAPI app; everything under /api is the backend.

Run (in container): uvicorn app.main:app --host 0.0.0.0 --port 8811
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

# Uvicorn only configures its own loggers, so without this the app's own
# log records (cache warm-ups, rebuild progress/failures) never reach the
# container logs and every diagnosis starts from an access log alone.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
# Telethon narrates every connection and encryption detail at INFO, which
# would bury this app's own scan/rebuild lines in the container logs.
logging.getLogger("telethon").setLevel(logging.WARNING)

from . import cache, health, refresh, telegram_client  # noqa: E402  (needs env vars loaded first)
from .routers import (  # noqa: E402
    auth,
    channels,
    collections,
    documents,
    downloads,
    integrations,
    jobs,
    playlists,
    search,
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Opening the database also runs the one-time import of a legacy
    # document_cache.json, which is slow enough to be worth keeping off
    # the event loop.
    await asyncio.to_thread(cache.init)
    await telegram_client.start()
    refresh.start()
    yield
    refresh.stop()
    # The probe pool's threads are parked on sockets with a few seconds left
    # on their timeouts; don't wait for them to notice.
    health.shutdown()
    await telegram_client.stop()
    cache.close()


app = FastAPI(title="Panda Vault", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(channels.router)
app.include_router(collections.router)
app.include_router(documents.router)
app.include_router(downloads.router)
app.include_router(integrations.router)
app.include_router(jobs.router)
app.include_router(playlists.router)
app.include_router(search.router)


# Telegram is one integration among several, not the front door: an install
# that only uses M3U playlists must be fully usable with no Telegram account
# at all. So the rule is inverted from what it used to be — instead of
# gating everything and exempting a couple of paths, only the routes that
# genuinely cannot work without a live Telethon session are gated.
#
# Anything reachable without Telegram (collections, playlists, search, the
# document cache) stays open. New Telegram-specific routes must be added
# here; new routes for other sources must not.
_TELEGRAM_GATED = ("/api/channels", "/api/download")


@app.middleware("http")
async def require_telegram_auth(request, call_next):
    if request.url.path.startswith(_TELEGRAM_GATED):
        if not await telegram_client.is_authorized():
            return JSONResponse({"detail": "Telegram login required"}, status_code=401)
    return await call_next(request)


@app.get("/api/health")
async def health_check():
    # Not `health`: that name is the health module imported above, and a
    # route function would shadow it — which it silently did, turning
    # health.shutdown() in the lifespan into an AttributeError that took
    # telegram_client.stop() and cache.close() down with it.
    return {"status": "ok"}


if os.path.isdir(STATIC_DIR):
    assets_dir = os.path.join(STATIC_DIR, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        # Never let the SPA catch-all swallow unmatched API routes with an
        # HTML response — surface a clean 404 JSON instead.
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = os.path.join(STATIC_DIR, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
