"""Loopback-only integration example: python -m uvicorn examples.app:app."""
import asyncio
import json
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from hermes_realtime_voice import create_voice_router

app = FastAPI()
sessions: set[str] = set()
runs: dict[str, dict] = {}
ROOT = Path(__file__).parent


@app.middleware('http')
async def loopback_only(request: Request, call_next):
    # This runnable example is intentionally local. Production hosts supply
    # their own authentication, session authorization and CSRF protection.
    host = request.headers.get('host', '')
    origin = request.headers.get('origin')
    if host not in {'127.0.0.1:8765', 'localhost:8765', '127.0.0.1:18765', 'localhost:18765'} or (origin and origin != 'http://' + host):
        return JSONResponse({'detail': 'Local same-origin requests only'}, status_code=403)
    return await call_next(request)


async def authenticate(request: Request) -> str:
    token = request.cookies.get('voice_example')
    if token not in sessions:
        raise HTTPException(401, 'Open the example page first')
    return token


app.include_router(create_voice_router(authenticate), prefix='/voice')


@app.get('/')
async def index(request: Request):
    response = FileResponse(ROOT / 'index.html')
    token = request.cookies.get('voice_example')
    if token not in sessions:
        if len(sessions) >= 32:
            raise HTTPException(429, 'Restart the local example to clear sessions')
        token = secrets.token_urlsafe(32)
        sessions.add(token)
        response.set_cookie('voice_example', token, httponly=True, samesite='strict')
    return response


@app.get('/example.js')
async def javascript():
    return FileResponse(ROOT / 'example.js', media_type='text/javascript')


class Turn(BaseModel):
    requestId: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=20000)
    language: str = Field(pattern='^(sv|en|fr|pl|es|uk|ru|ar)$')


class Correction(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


def upstream():
    base = os.getenv('HERMES_VOICE_AGENT_URL', '').rstrip('/')
    key = os.getenv('HERMES_VOICE_AGENT_TOKEN', '')
    if not base:
        return None
    parsed = urlsplit(base)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment or not key:
        raise HTTPException(503, 'Configure an HTTPS Hermes gateway and server-side token')
    return base, key


def headers(token, key, request_id=None):
    value = {'Authorization': 'Bearer ' + key, 'X-Hermes-Session-Key': 'voice-example:' + token}
    if request_id:
        value['Idempotency-Key'] = request_id
    return value


async def command(path, token, body, request_id=None):
    base, key = upstream()
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as client:
        async with client.post(base + path, json=body, headers=headers(token, key, request_id), allow_redirects=False) as response:
            if response.status >= 300:
                raise HTTPException(502, 'Hermes gateway rejected the request')
            return await response.json()


def owned(run_id, token):
    run = runs.get(run_id)
    if not run or run['owner'] != token:
        raise HTTPException(404, 'Run not found')
    return run


@app.post('/agent/runs')
async def submit(body: Turn, token=Depends(authenticate)):
    if len(runs) >= 128:
        raise HTTPException(429, 'Restart the local example to clear runs')
    if upstream():
        result = await command('/v1/runs', token, {'input': body.text}, body.requestId)
        remote = result.get('run_id')
        if not isinstance(remote, str) or not remote or len(remote) > 256:
            raise HTTPException(502, 'Invalid Hermes run identifier')
    else:
        remote = None
    run_id = secrets.token_urlsafe(24)
    runs[run_id] = {'owner': token, 'remote': remote, 'text': body.text, 'stopped': False}
    return {'id': run_id, 'mode': 'hermes' if remote else 'echo-demo'}


@app.get('/agent/runs/{run_id}/events')
async def events(run_id: str, token=Depends(authenticate)):
    run = owned(run_id, token)

    async def stream():
        if not run['remote']:
            for word in run['text'].split(' '):
                if run['stopped']:
                    return
                yield 'data: ' + json.dumps({'type': 'text', 'text': word + ' '}) + '\n\n'
                await asyncio.sleep(0.04)
            yield 'data: {"type":"complete"}\n\n'
            return
        from urllib.parse import quote
        base, key = upstream()
        timeout = aiohttp.ClientTimeout(total=None, connect=10, sock_read=35)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.get(base + '/v1/runs/' + quote(run['remote'], safe='') + '/events',
                                      headers=headers(token, key), allow_redirects=False) as response:
                    if response.status != 200:
                        raise RuntimeError('Gateway unavailable')
                    async for raw in response.content:
                        if len(raw) > 65536:
                            raise RuntimeError('Oversized event')
                        if not raw.startswith(b'data: '):
                            continue
                        event = json.loads(raw[6:])
                        if event.get('run_id') != run['remote']:
                            raise RuntimeError('Mismatched run')
                        name = event.get('event')
                        if name == 'message.delta' and isinstance(event.get('delta'), str):
                            mapped = {'type': 'text', 'text': event['delta']}
                        elif name in {'run.completed', 'run.redirected', 'run.failed', 'run.cancelled'}:
                            mapped = {'type': {'run.completed': 'complete', 'run.redirected': 'redirected'}.get(name, 'error')}
                        else:
                            continue
                        yield 'data: ' + json.dumps(mapped) + '\n\n'
                        if mapped['type'] in {'complete', 'error'}:
                            return
                    raise RuntimeError('Stream ended without a terminal event')
        except (aiohttp.ClientError, TimeoutError, ValueError, RuntimeError):
            yield 'data: {"type":"error"}\n\n'

    return StreamingResponse(stream(), media_type='text/event-stream')


@app.post('/agent/runs/{run_id}/stop')
async def stop(run_id: str, token=Depends(authenticate)):
    run = owned(run_id, token)
    run['stopped'] = True
    if run['remote']:
        from urllib.parse import quote
        await command('/v1/runs/' + quote(run['remote'], safe='') + '/stop', token, {})
    return {'stopped': True}


@app.post('/agent/runs/{run_id}/redirect')
async def redirect(run_id: str, body: Correction, token=Depends(authenticate)):
    run = owned(run_id, token)
    if not run['remote']:
        raise HTTPException(409, 'Echo demo starts a new run for corrections')
    from urllib.parse import quote
    result = await command('/v1/runs/' + quote(run['remote'], safe='') + '/redirect', token, {'input': body.text})
    if result.get('accepted') is not True:
        raise HTTPException(409, 'Correction not accepted')
    return {'accepted': True}
