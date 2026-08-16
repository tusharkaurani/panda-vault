"""
Panda Vault — organizes documents from many Telegram channels into a
collection tree, with a card-based UI for browsing and an in-app Settings
screen for managing channels/collections. The built React/Tailwind SPA
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

from . import cache, telegram_client  # noqa: E402  (needs env vars loaded first)
from .routers import auth, channels, collections, documents, downloads, search  # noqa: E402

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Opening the database also runs the one-time import of a legacy
    # document_cache.json, which is slow enough to be worth keeping off
    # the event loop.
    await asyncio.to_thread(cache.init)
    await telegram_client.start()
    telegram_client.start_refresh_loop()
    yield
    telegram_client.stop_refresh_loop()
    await telegram_client.stop()
    cache.close()


app = FastAPI(title="Panda Vault", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(channels.router)
app.include_router(collections.router)
app.include_router(documents.router)
app.include_router(downloads.router)
app.include_router(search.router)


@app.middleware("http")
async def require_telegram_auth(request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path != "/api/health" and not path.startswith("/api/auth/"):
        if not await telegram_client.is_authorized():
            return JSONResponse({"detail": "Telegram login required"}, status_code=401)
    return await call_next(request)


@app.get("/api/health")
async def health():
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
