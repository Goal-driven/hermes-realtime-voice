"""Mount existing Qwen transport behind the host application's authentication."""
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from dashboard import plugin_api as transport


def create_voice_router(authenticate: Callable[..., Awaitable[str]]) -> APIRouter:
    """authenticate must return a stable user/tenant ID or raise HTTPException.

    Mount once per process; channels are process-local, so use sticky routing.
    The host must protect cookie-authenticated writes against CSRF.
    """
    router = APIRouter()
    owners: dict[str, str] = {}

    def check(channel: str, principal: str) -> None:
        if not principal or owners.get(channel) != principal:
            raise HTTPException(404, "Voice channel not found")

    async def identity(principal: str = Depends(authenticate)) -> str:
        if not isinstance(principal, str) or not principal:
            raise HTTPException(401, "Authentication required")
        return principal

    @router.get('/status')
    async def status(language: str = "sv", principal: str = Depends(identity)):
        return await transport.status(language)

    @router.get('/client.js')
    async def client(principal: str = Depends(identity)):
        return FileResponse(Path(__file__).parent / 'browser' / 'voice.js', media_type='text/javascript')

    @router.post('/session')
    async def session(body: transport.Offer, principal: str = Depends(identity)):
        return await transport.speech_session(body)

    @router.post('/channel')
    async def channel(principal: str = Depends(identity)):
        value = await transport.create_channel()
        for expired in owners.keys() - transport.CHANNELS.keys():
            owners.pop(expired, None)
        owners[value['channel']] = principal
        return value

    @router.post('/channel/close')
    async def close(body: transport.ChannelRequest, principal: str = Depends(identity)):
        check(body.channel, principal)
        result = await transport.close_channel(body)
        owners.pop(body.channel, None)
        return result

    @router.post('/tts/speak', status_code=202)
    async def speak(body: transport.Speak, principal: str = Depends(identity)):
        check(body.channel, principal)
        return await transport.tts_speak(body)

    @router.post('/tts/cancel')
    async def cancel(body: transport.ChannelRequest, principal: str = Depends(identity)):
        check(body.channel, principal)
        return await transport.tts_cancel(body)

    @router.get('/events/poll')
    async def poll(channel: str, principal: str = Depends(identity)):
        check(channel, principal)
        return await transport.poll_event(channel)

    return router
