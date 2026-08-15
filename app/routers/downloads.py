from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import store
from ..telegram_client import download_stream

router = APIRouter(prefix="/api/download", tags=["downloads"])


@router.get("/{channel_id}/{msg_id}")
async def download(channel_id: str, msg_id: int):
    channel = next((c for c in store.load_channels() if c.id == channel_id), None)
    if not channel:
        raise HTTPException(404, "Channel not found")

    try:
        result = await download_stream(channel.channel, msg_id)
    except Exception as e:
        raise HTTPException(502, f"Could not reach Telegram: {e}")

    if not result:
        raise HTTPException(404, "File not found")
    gen, filename, size, mime = result

    # HTTP headers must be latin-1 encodable. Telegram filenames/captions can
    # contain arbitrary unicode (emoji, "●", non-Latin scripts) which raises
    # UnicodeEncodeError if put directly into Content-Disposition. Use a
    # sanitized ASCII fallback for `filename=` and the real name via the
    # RFC 5987 `filename*=UTF-8''...` form (which browsers use when present).
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii").strip() or "download"
    content_disposition = (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{quote(filename)}"
    )

    return StreamingResponse(
        gen(),
        media_type=mime,
        headers={
            "Content-Disposition": content_disposition,
            "Content-Length": str(size),
        },
    )
