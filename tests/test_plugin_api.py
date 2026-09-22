from pathlib import Path

import pytest
from fastapi import HTTPException

from dashboard import plugin_api as voice

MODULE = Path(voice.__file__)
PLUGIN_MANIFEST = MODULE.parents[1] / "plugin.yaml"


def test_qwen_url_is_restricted_to_alibaba_https():
    allowed = "https://ws-example.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime"
    assert voice._allowed_qwen_url(allowed) == allowed
    for value in [
        "http://ws-example.aliyuncs.com/api/v1/webrtc/realtime",
        "https://aliyuncs.com.attacker.example/realtime",
        "https://user:password@ws-example.aliyuncs.com/realtime",
        "https://ws-example.aliyuncs.com:8443/api/v1/webrtc/realtime",
        "https://ws-example.aliyuncs.com:notaport/api/v1/webrtc/realtime",
        "https://ws-example.aliyuncs.com/api/v1/webrtc/other",
        "https://ws-example.aliyuncs.com/api/v1/webrtc/realtime?redirect=1",
        "https://ws-example.aliyuncs.com/api/v1/webrtc/realtime#fragment",
    ]:
        with pytest.raises(HTTPException):
            voice._allowed_qwen_url(value)


def test_tts_url_uses_same_workspace_and_fixed_model():
    source = "https://ws-example.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime"
    assert voice._tts_url(source) == (
        "wss://ws-example.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime"
        "?model=qwen3-tts-flash-realtime"
    )


@pytest.mark.asyncio
async def test_status_declares_transport_only_without_exposing_secret(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "secret-value")
    monkeypatch.setenv(
        "HERMES_VOICE_QWEN_REALTIME_URL",
        "https://ws-example.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime",
    )
    result = await voice.status()
    assert result["configured"] is True
    assert result["brain"] == "active-hermes-profile"
    assert result["transport_only"] is True
    assert "secret-value" not in repr(result)
    assert result["session_update"]["tools"] == []
    assert "Transcribe speech only" in result["session_update"]["instructions"]


def test_plugin_has_no_omarchy_or_openrouter_dependency():
    source = MODULE.read_text(encoding="utf-8").lower()
    assert "omarchy" not in source
    assert "openrouter" not in source


def test_manifest_remains_compatible_with_hermes_v1_installers():
    manifest = PLUGIN_MANIFEST.read_text(encoding="utf-8")
    assert "manifest_version:" not in manifest
    assert "api_version:" not in manifest
    assert "name: hermes-realtime-voice" in manifest


@pytest.mark.asyncio
async def test_poll_event_delivers_only_the_selected_channel():
    first = voice.VoiceChannel("a" * 43)
    second = voice.VoiceChannel("b" * 43)
    voice.CHANNELS[first.token] = first
    voice.CHANNELS[second.token] = second
    try:
        await first.emit({"type": "done", "id": "voice:1"})
        result = await voice.poll_event(first.token)
        assert result == {"type": "done", "id": "voice:1"}
        assert second.queue.empty()
        assert first.subscribers == 0
    finally:
        voice.CHANNELS.pop(first.token, None)
        voice.CHANNELS.pop(second.token, None)
