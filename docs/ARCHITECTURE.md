# Architecture

## Ownership

Hermes is the agent. The selected profile owns the model, system instructions, tools, session continuity, project context and memory policy. When Honcho is enabled in that profile, Honcho remains the long-term memory provider.

The voice plugin owns only media transport and turn coordination:

1. Browser audio is sent to a configured ASR adapter.
2. The final transcript is submitted to the focused Hermes runtime session through `prompt.submit`.
3. Only `message.delta` text from that exact runtime session enters the speech queue.
4. The TTS adapter receives bounded exact-text segments and returns PCM.
5. Microphone capture remains active during playback; new speech cancels queued and playing audio.

Reasoning events, tool events, system prompts, memory records and full history never enter the TTS path.

## Package shape

This is one Hermes plugin package:

```text
plugin.yaml
dashboard/
  manifest.json
  plugin_api.py
desktop/
  plugin.js
```

The Python backend keeps provider credentials, creates WebRTC sessions and maintains preconnected TTS channels. The desktop half owns microphone permission, WebRTC, active-session routing and WebAudio playback.

## Provider boundary

The desktop depends on the neutral `/status`, `/session`, `/channel`, `/tts/*` and `/events/poll` contract. It consumes speech events through authenticated immediate long polling because Hermes disables plugin WebSockets on some OAuth remote connections. `/status` supplies the provider-specific realtime session update, so the desktop does not hardcode a model identifier or endpoint. The first adapter uses Qwen's OpenAI-compatible realtime event vocabulary. A provider with a different wire protocol must translate events in its transport adapter while preserving this public contract.

Qwen is the sole speech provider. Packaging and language extensions must pass:

- transcription-only input behavior;
- exact-text-only TTS behavior;
- no autonomous provider response;
- interruption and simultaneous listening/playback;
- secret confinement to the backend;
- first activation below 3 seconds;
- warm first audio in 1.5–2.0 seconds;
- unchanged Hermes tools, profile and memory behavior.

## Omarchy

Omarchy may install this plugin and select `omarchyvoicecandidate`. Other Hermes users install the same repository and use another profile. The plugin contains no Omarchy host name, API key, session ID or profile name.

## Reusable module boundary (2026-10-13)

`hermes_realtime_voice/browser/voice.js` is extracted from the existing Desktop
controller; `desktop/plugin.js` is now its host adapter. The Python package
mounts the existing `dashboard.plugin_api` transport with host authentication
and per-principal channel ownership. The standalone example injects a durable
Hermes run adapter. It does not share deployment credentials, profiles or memory
identities with Omarchy.

The owner explicitly fixed Qwen as the sole ASR/TTS provider. Language gaps are
pending capabilities, not permission to add a second provider. Hermes remains
the sole brain and orchestrator, and memory remains behind Hermes. No production
rollout is included. See INTEGRATION.md for the SDK adapter's narrower guarantees.
