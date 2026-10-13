# Hermes Realtime Voice

Portable realtime voice for Hermes. Speech providers transport audio; the active Hermes profile remains the only agent that reasons, uses tools, and owns memory.

```text
microphone → ASR transport → active Hermes session → TTS transport → speakers
                              └─ tools + memory + Honcho policy
```

The first provider adapter uses Alibaba Model Studio Qwen:

- `qwen3-asr-flash-realtime` for transcription;
- the selected Hermes profile for every substantive response;
- `qwen3-tts-flash-realtime` for exact-text speech synthesis.

Qwen cannot answer the user or call tools. Unsolicited Qwen responses are cancelled. The plugin never sends the Hermes system prompt, tool schemas, hidden reasoning, Honcho state, or conversation history to the speech provider.

## Reuse in another application

Use the packaged browser controller and authenticated Python router described in
[the integration guide](docs/INTEGRATION.md). A separate, runnable example lives
in `examples/`. It can connect to a host's Hermes run API or run an explicit echo
demo. The original Hermes plugin remains an adapter to the same browser module.

**Fixed architecture:** Qwen is the only speech provider. Hermes owns reasoning,
agent orchestration and session/memory policy. Packaging must not introduce a
second brain, an additional speech provider, or hardcoded deployment identities.
The existing deployment is not modified by installing/building this package.

[Language status and verification](docs/VERIFICATION.md) distinguishes vendor
support, isolated provider tests and microphone/speaker acceptance. French,
Spanish and Russian have Qwen ASR/TTS support; Polish, Ukrainian and Arabic
remain pending Qwen TTS support. Romanian is excluded. Swedish and English
retain the existing Qwen path.

## Install

```bash
hermes plugins install Goal-driven/hermes-realtime-voice --enable
```

Then enable **Hermes Realtime Voice** in the desktop app's **Capabilities → Plugins** panel. The Python and desktop halves are opt-in independently by Hermes design.

One-click install:

```text
hermes://plugin/install?repo=Goal-driven/hermes-realtime-voice&enable=1
```

## Configure Qwen

Set these in the target Hermes profile's environment:

```bash
DASHSCOPE_API_KEY=...
HERMES_VOICE_QWEN_REALTIME_URL=https://<workspace>.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime
# Optional; defaults to Cherry
HERMES_VOICE_QWEN_VOICE=Cherry
```

Credentials remain in the Hermes backend. The browser receives an SDP answer, short-lived channel identifier, transcription events, and synthesized PCM only.

Start Hermes Desktop, open the profile and conversation that should own the voice turn, then click **voice** in the status bar. The plugin sends `prompt.submit` to that focused runtime session with `surface: voice`. This means:

- any Hermes profile can be the brain;
- the profile's model and tools remain available;
- Honcho or another configured Hermes memory plugin remains the memory layer;
- `omarchyvoicecandidate` is one deployment profile, not a dependency of this repository.

## Provider contract

The desktop talks only to provider-neutral plugin routes:

- `GET /status`
- `POST /session`
- `POST /channel`
- `POST /tts/speak`
- `POST /tts/cancel`
- `GET /events/poll`

The desktop uses authenticated immediate long polling so remote Hermes backends work as well as local ones.

Qwen remains the sole speech provider. Additional language coverage is gated on verified Qwen ASR and TTS support; provider replacement is outside this package change.

## Latency targets

- first activation: less than 3 seconds to first audible response;
- warm turns: 1.5–2.0 seconds from speech stop to first audible response;
- listening stays active during playback and user speech cancels current TTS.

Provider preconnect happens at activation. Hermes text is spoken at sentence boundaries or an early safe word boundary while the remainder continues streaming.

## Development

```bash
python3 -m pip install -e '.[test]'
python3 -m pytest -q
node --test tests/*.test.mjs
node --check desktop/plugin.js
python3 -m py_compile dashboard/plugin_api.py
```

See [architecture](docs/ARCHITECTURE.md) and [security policy](SECURITY.md).
