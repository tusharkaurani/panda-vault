import logging

from fastapi import APIRouter, HTTPException
from telethon.errors import (
    PasswordHashInvalidError,
    PhoneCodeExpiredError,
    PhoneCodeInvalidError,
    PhoneNumberInvalidError,
)

from .. import telegram_client
from ..models import CodeIn, PasswordIn, PhoneIn

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = logging.getLogger("panda_vault.auth")


@router.get("/status")
async def status():
    return {"authorized": await telegram_client.is_authorized()}


@router.post("/send-code")
async def send_code(body: PhoneIn):
    try:
        await telegram_client.send_code(body.phone)
    except PhoneNumberInvalidError:
        raise HTTPException(400, "Invalid phone number")
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"sent": True}


@router.post("/sign-in")
async def sign_in(body: CodeIn):
    try:
        authorized = await telegram_client.sign_in_code(body.code)
    except (PhoneCodeInvalidError, PhoneCodeExpiredError):
        raise HTTPException(400, "Invalid or expired code — request a new one")
    except Exception as e:
        raise HTTPException(400, str(e))
    if not authorized:
        return {"authorized": False, "needsPassword": True}
    return {"authorized": True}


@router.post("/sign-in-password")
async def sign_in_password(body: PasswordIn):
    try:
        await telegram_client.sign_in_password(body.password)
    except PasswordHashInvalidError:
        raise HTTPException(400, "Incorrect password")
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"authorized": True}


@router.post("/qr-login/start")
async def qr_login_start():
    try:
        url, expires = await telegram_client.qr_login_start()
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"url": url, "expires": expires}


@router.get("/qr-login/poll")
async def qr_login_poll():
    return telegram_client.qr_login_poll()
