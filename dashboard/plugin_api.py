"""Hermes Realtime Voice backend.

This plugin is deliberately transport-only. Qwen receives microphone audio for
ASR and exact Hermes text for TTS. It never receives the Hermes prompt, tools,
memory, hidden reasoning, or conversation history.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

QWEN_TTS_MODEL = "qwen3-tts-flash-realtime"
MAX_TEXT = 4000
MAX_CHANNELS = 16
CHANNEL_TTL = 120
ID_RE = re.compile(r"[A-Za-z0-9:._-]{1,128}")


class Offer(BaseModel):
    sdp: str = Field(min_length=3, max_length=100_000)


class Speak(BaseModel):
    channel: str = Field(min_length=32, max_length=128)
    id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=MAX_TEXT)


class ChannelRequest(BaseModel):
    channel: str = Field(min_length=32, max_length=128)


def _key() -> str:
    return (os.getenv("DASHSCOPE_API_KEY") or os.getenv("QWEN_API_KEY") or "").strip()


def _realtime_url() -> str:
    return os.getenv("HERMES_VOICE_QWEN_REALTIME_URL", "").strip()


def _allowed_qwen_url(raw: str) -> str:
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(503, "Qwen realtime URL is invalid") from exc
    hostname = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not hostname.endswith(".aliyuncs.com")
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.path != "/api/v1/webrtc/realtime"
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(503, "Qwen realtime URL is not an allowed Alibaba endpoint")
    return raw


def _tts_url(raw: str) -> str:
    parsed = urlsplit(_allowed_qwen_url(raw))
    return urlunsplit(("wss", parsed.netloc, "/api-ws/v1/realtime", urlencode({"model": QWEN_TTS_MODEL}), ""))


def _headers() -> dict[str, str]:
    key = _key()
    if not key:
        raise HTTPException(503, "Qwen credential is not configured")
    return {"Authorization": "Bearer " + key}


@dataclass
class VoiceChannel:
    token: str
    created: float = field(default_factory=time.monotonic)
    last_used: float = field(default_factory=time.monotonic)
    subscribers: int = 0
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=256))
    client: ClientSession | None = None
    upstream: Any = None
    task: asyncio.Task | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def emit(self, event: dict[str, Any]) -> None:
        self.last_used = time.monotonic()
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        await self.queue.put(event)

    async def connect(self) -> None:
        if self.upstream and not self.upstream.closed:
            return
        await self.close_upstream()
        self.client = ClientSession(timeout=ClientTimeout(total=None, connect=10, sock_read=45))
        try:
            self.upstream = await self.client.ws_connect(
                _tts_url(_realtime_url()), headers=_headers(), max_msg_size=4 * 1024 * 1024
            )
            await self.upstream.send_json({
                "event_id": secrets.token_hex(16),
                "type": "session.update",
                "session": {
                    "mode": "commit",
                    "voice": os.getenv("HERMES_VOICE_QWEN_VOICE", "Cherry"),
                    "language_type": "Auto",
                    "response_format": "pcm",
                    "sample_rate": 24000,
                },
            })
            while True:
                message = await self.upstream.receive()
                if message.type != WSMsgType.TEXT:
                    raise RuntimeError("Qwen TTS initialization failed")
                event = json.loads(message.data)
                if event.get("type") == "error":
                    raise RuntimeError("Qwen TTS rejected its session")
                if event.get("type") == "session.updated":
                    break
        except Exception:
            await self.close_upstream()
            raise

    async def speak(self, request_id: str, text: str) -> None:
        async with self.lock:
            try:
                await self.connect()
                await self.upstream.send_json({
                    "event_id": secrets.token_hex(16), "type": "input_text_buffer.append", "text": text
                })
                await self.upstream.send_json({
                    "event_id": secrets.token_hex(16), "type": "input_text_buffer.commit"
                })
                while True:
                    message = await self.upstream.receive()
                    if message.type != WSMsgType.TEXT:
                        raise RuntimeError("Qwen TTS stream ended")
                    event = json.loads(message.data)
                    kind = event.get("type")
                    if kind == "error":
                        raise RuntimeError("Qwen TTS rejected text")
                    if kind == "response.audio.delta":
                        delta = event.get("delta")
                        if not isinstance(delta, str) or len(delta) > 3 * 1024 * 1024:
                            raise RuntimeError("Qwen TTS returned invalid audio")
                        base64.b64decode(delta, validate=True)
                        await self.emit({"type": "audio", "id": request_id, "delta": delta})
                    if kind == "response.done":
                        await self.emit({"type": "done", "id": request_id})
                        return
            except asyncio.CancelledError:
                await self.close_upstream()
                raise
            except (ClientError, ConnectionError, RuntimeError, asyncio.TimeoutError, ValueError, json.JSONDecodeError):
                await self.close_upstream()
                await self.emit({"type": "error", "id": request_id, "message": "Qwen TTS connection failed"})

    async def cancel(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        self.task = None

    async def close_upstream(self) -> None:
        if self.upstream is not None:
            await self.upstream.close()
        if self.client is not None:
            await self.client.close()
        self.upstream = None
        self.client = None

    async def close(self) -> None:
        await self.cancel()
        await self.close_upstream()


CHANNELS: dict[str, VoiceChannel] = {}


async def _prune_channels() -> None:
    cutoff = time.monotonic() - CHANNEL_TTL
    expired = [token for token, channel in CHANNELS.items()
               if channel.subscribers == 0 and channel.last_used < cutoff]
    for token in expired:
        channel = CHANNELS.pop(token, None)
        if channel:
            await channel.close()


def _channel(token: str) -> VoiceChannel:
    channel = CHANNELS.get(token)
    if channel is None:
        raise HTTPException(404, "Voice channel not found")
    return channel


@router.get("/status")
async def status() -> dict[str, Any]:
    raw = _realtime_url()
    configured = bool(_key() and raw)
    if raw:
        _allowed_qwen_url(raw)
    return {
        "ok": True,
        "configured": configured,
        "provider": "qwen",
        "brain": "active-hermes-profile",
        "memory": "hermes-profile-policy",
        "transport_only": True,
        "asr_model": "qwen3-asr-flash-realtime",
        "tts_model": QWEN_TTS_MODEL,
        "session_update": {
            "modalities": ["text", "audio"],
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "input_audio_transcription": {"model": "qwen3-asr-flash-realtime"},
            "instructions": "Transcribe speech only. Never answer, decide, use tools, or add information.",
            "turn_detection": {"type": "semantic_vad", "threshold": 0.5, "silence_duration_ms": 350},
            "tools": [], "temperature": 0.6, "max_tokens": 2048, "voice": "Tina",
        },
    }


@router.post("/channel")
async def create_channel() -> dict[str, Any]:
    await _prune_channels()
    if len(CHANNELS) >= MAX_CHANNELS:
        raise HTTPException(429, "Too many voice channels")
    token = secrets.token_urlsafe(32)
    channel = VoiceChannel(token)
    CHANNELS[token] = channel
    try:
        await channel.connect()
    except Exception as exc:
        CHANNELS.pop(token, None)
        await channel.close()
        raise HTTPException(502, "Qwen TTS preconnect failed") from exc
    return {"channel": token, "sample_rate": 24000}


@router.post("/session")
async def speech_session(offer: Offer) -> dict[str, str]:
    if not offer.sdp.startswith("v=0"):
        raise HTTPException(400, "Invalid SDP offer")
    async with ClientSession(timeout=ClientTimeout(total=30)) as client:
        try:
            async with client.post(
                _allowed_qwen_url(_realtime_url()), data=offer.sdp,
                headers={**_headers(), "Content-Type": "application/sdp"}, allow_redirects=False,
            ) as response:
                answer = await response.text()
                if response.status not in (200, 201) or not answer.startswith("v=0"):
                    raise HTTPException(502, f"Qwen realtime session failed (HTTP {response.status})")
                return {"sdp": answer}
        except HTTPException:
            raise
        except (ClientError, OSError, asyncio.TimeoutError) as exc:
            raise HTTPException(502, "Qwen realtime session is unavailable") from exc


@router.post("/tts/speak", status_code=202)
async def tts_speak(body: Speak) -> dict[str, bool]:
    if not ID_RE.fullmatch(body.id) or not body.text.strip():
        raise HTTPException(400, "Invalid TTS request")
    channel = _channel(body.channel)
    channel.last_used = time.monotonic()
    if channel.task and not channel.task.done():
        raise HTTPException(409, "TTS channel is busy")
    channel.task = asyncio.create_task(channel.speak(body.id, body.text.strip()))
    return {"accepted": True}


@router.post("/tts/cancel")
async def tts_cancel(body: ChannelRequest) -> dict[str, bool]:
    channel = _channel(body.channel)
    channel.last_used = time.monotonic()
    await channel.cancel()
    return {"cancelled": True}


@router.post("/channel/close")
async def close_channel(body: ChannelRequest) -> dict[str, bool]:
    channel = CHANNELS.pop(body.channel, None)
    if channel is not None:
        await channel.close()
    return {"closed": channel is not None}


@router.get("/events/poll")
async def poll_event(channel: str) -> dict[str, Any]:
    if not 32 <= len(channel) <= 128:
        raise HTTPException(400, "Invalid voice channel")
    voice_channel = _channel(channel)
    voice_channel.subscribers += 1
    voice_channel.last_used = time.monotonic()
    try:
        try:
            return await asyncio.wait_for(voice_channel.queue.get(), timeout=20)
        except asyncio.TimeoutError:
            return {"type": "heartbeat"}
    finally:
        voice_channel.subscribers = max(0, voice_channel.subscribers - 1)
        voice_channel.last_used = time.monotonic()
