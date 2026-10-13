# Integrate voice into a host application

This repository ships an ES module and a Python server package. The module handles microphone transport, audio playback, turn IDs, interruptions and streamed text. Your application supplies its authenticated agent session. Hermes remains the only reasoning agent; its configured memory provider, including Honcho, remains unchanged.

## Install and run the separate example

From an isolated checkout:

```sh
python3 -m venv /tmp/hermes-voice-example
/tmp/hermes-voice-example/bin/pip install -e '.[example]'
/tmp/hermes-voice-example/bin/python -m uvicorn examples.app:app --host 127.0.0.1 --port 18765
```

Open `http://127.0.0.1:18765`. The UI displays AI-voice disclosure and five selectable languages; Polish, Ukrainian and Arabic are visibly pending. Qwen is the only permitted speech provider. Set speech credentials in the server environment before starting. Nothing is written into browser storage or frontend source.

- `DASHSCOPE_API_KEY`: Qwen speech credential.
- `HERMES_VOICE_QWEN_REALTIME_URL`: existing Alibaba workspace HTTPS WebRTC URL, without a query string.
- `HERMES_VOICE_QWEN_VOICE`: optional, defaults to the existing `Cherry` voice.
- `HERMES_VOICE_AGENT_URL`: optional HTTPS Hermes gateway base URL, with `/v1/runs` support.
- `HERMES_VOICE_AGENT_TOKEN`: that gateway's server-side token.

With no agent gateway configured, the example deterministically echoes input to demonstrate the integration. It is not an additional reasoning agent. With a gateway configured, its run API supplies the response, redirect and stop operations. The example uses a new cookie-scoped session key; it does not attach to an existing person's shared memory identity.

The example accepts only localhost hosts on ports 8765 or 18765 and rejects cross-origin requests. Do not expose it as a production authentication service. Its in-memory sessions/runs are deliberately bounded and reset when restarted.

## Server integration

```python
from hermes_realtime_voice import create_voice_router

# existing_auth must authenticate the request and return a stable user/tenant
# identifier, or raise HTTPException. Never return a browser-supplied user ID.
app.include_router(create_voice_router(existing_auth), prefix="/voice")
```

This reuses the original `dashboard.plugin_api` transport. It adds authentication to every route and binds each channel to its authenticated owner. The host still owns authorization of agent sessions, CSRF protection for cookie-authenticated writes, rate limits and lifecycle shutdown. Channels are process-local; use one worker or sticky routing. Mount one router per application. Do not mount the legacy plugin router publicly; that entrypoint relies on Hermes authentication.

Routes are `/status?language=sv`, `/client.js`, `/session`, `/channel`, `/channel/close`, `/tts/speak`, `/tts/cancel` and `/events/poll`. Existing request shapes remain compatible; session/speak requests additionally accept `language`. The selected language never changes the agent model or profile.

## Browser integration

Import `VoiceController` from the server's `/voice/client.js`, or import the npm-compatible package's ES module in a bundler. There are no browser runtime dependencies beyond WebRTC, WebAudio and standard browser APIs. Microphone permission requires HTTPS or localhost.

```js
const voice = new VoiceController({
  rest, // authenticated rest(path, {method, body, timeoutMs}) -> parsed JSON
  agent,
  language: 'sv',
  onState: ({active, phase, detail}) => renderStatus(active, phase, detail),
  onTranscript: text => renderTranscript(text),
  onMetric: measurement => recordMeasurement(measurement),
  onError: error => showError(error),
})
await voice.start()
await voice.setLanguage('fr')
await voice.stop()
```

Always await a language change and handle a rejected change. Languages pending Qwen TTS support produce 422 before switching. Text should be rendered as text, never as HTML. Use `dir="auto"` for Arabic transcripts. The eight language codes are `sv`, `en`, `fr`, `pl`, `es`, `uk`, `ru`, `ar`; Romanian was explicitly excluded.

## Agent interface

`agent.sessionId()` returns the host's selected, authorized conversation identifier, pinned when voice starts. Stop/restart to attach to another conversation.

`agent.submit({sessionId, requestId, text, language, signal, onEvent})` starts a voice turn and resolves a handle:

- `id`: the host's run ID, useful for observability.
- `stop()`: stops that exact remote run. Aborting a local fetch alone is insufficient.
- `redirect(text, language)`: optional correction of that same running operation. Emit `redirected` only after the remote service acknowledges the correction.

The adapter delivers only public answer text and lifecycle events to `onEvent`:

```js
onEvent({type: 'text', text: 'A streamed answer fragment'})
onEvent({type: 'redirected'})
onEvent({type: 'complete'})
onEvent({type: 'error'})
```

Bind events to the exact run, including server-side authorization. Do not forward tool results, hidden reasoning, credentials or memory records. A submit that finishes after cancellation must still return its handle so the controller can stop the orphaned remote run. Use `requestId` as the idempotency key. `signal` closes event consumption; `stop()` performs remote cancellation. Terminal completion must be explicit; an unexpected EOF is an error.

On user speech, local playback stops immediately while the active run pauses its output. A short backchannel resumes buffered output. A correction uses `redirect()` if available, fences old deltas until `redirected`, and falls back to stopping/restarting the run if rejected or unacknowledged after five seconds. Adapters without redirect start a new run in the same session. Completed audio may be interrupted mid-segment; resuming a backchannel can replay the interrupted segment. No claim is made of sample-accurate resume.

A swarm stays behind this interface: Hermes may delegate internally, but only its public answer enters voice. There is no swarm scheduler in this package.

## Hermes Desktop compatibility

The Desktop adapter uses the existing `prompt.submit` and session-scoped events. That SDK path does not establish a documented durable run stop/redirect contract. Its `stop()` detaches event delivery rather than cancelling remote work. Do not claim the durable-run guarantees for Desktop; verify the SDK's run IDs before adding that integration. The separate example demonstrates the durable-run boundary.

## Licenses and dependencies

Repository code is MIT. Python requires 3.11+, aiohttp (Apache-2.0), FastAPI (MIT), Pydantic (MIT); the example adds Uvicorn (BSD-3-Clause). Test-only dependencies are pytest, pytest-asyncio and httpx (MIT). Packaging uses setuptools. The Desktop wrapper additionally requires the host's Hermes plugin SDK and React runtime; the standalone browser module does not. Model weights are not redistributed. Alibaba hosted API terms and usage charges apply separately.

The Python wheel includes the browser module. `package.json` allows `npm pack`/local installation without downloading node_modules; no public registry publication is part of this change.

The Desktop adapter source is `desktop/entry.js`. `npm ci --ignore-scripts && npm run build:desktop` bundles the shared controller into the existing single `desktop/plugin.js` entrypoint, keeping the runtime loader contract unchanged. CI verifies that generated output matches source. esbuild (MIT) is a build-only dependency.
