# Verification record — 2026-10-13

## Fixed requirements

Qwen is the only speech provider. The voice layer owns audio and conversation lifecycle; Hermes owns reasoning/orchestration; memory stays behind Hermes. Existing Swedish/English configuration and the running deployment must be preserved. Additional providers are excluded by the owner's explicit decision. Romanian is excluded. No deployment was changed by this work.

## Inventory and provenance

The fetched `origin/main` was `b1f8b3d163915d8b51821102bd1ab2b2bac2172c`, owned by Goal-driven/hermes-realtime-voice. The main checkout was on `main`; work used a separate topic worktree. There was already another session's worktree, which was not reused.

The repository's Desktop controller and Python Qwen transport were compared against the deployed candidate's `server.py`, `hermes_service.py`, `static/app.js`, `static/native-voice.js` and `static/streaming-speech.js`, read over SSH. That deployment directory has no Git metadata, so its exact source revision is unknown. Its active process configuration confirms Qwen and an Alibaba Singapore workspace. No credentials, entire environment, or memory configuration were printed.

Observed differences: the candidate waits for `session.updated` before attaching the microphone, accepts the incoming `txt` data channel, uses request/run identifiers, redirects in-flight Hermes runs, and buffers overlapping user speech. The portable controller applies these behaviors to the existing repository's media implementation. It is an extraction/adaptation, not a byte-identical copy of the deployed candidate. Candidate-specific history receipts are owned by the host; the portable module does not write to its database.

## Languages

Official sources checked on 2026-10-13:

- [Qwen ASR models](https://help.aliyun.com/en/model-studio/asr-model)
- [Qwen TTS models](https://www.alibabacloud.com/help/en/model-studio/tts-model/)
- [Qwen voices, including Cherry](https://help.aliyun.com/en/model-studio/qwen-tts-voice-list)

| Language | Qwen ASR listed | Current Qwen TTS listed | Module status |
| --- | --- | --- | --- |
| Swedish | Yes | No | Preserve existing user-reported working path; quality acceptance still required |
| English | Yes | Yes | Existing path preserved |
| French | Yes | Yes | Selectable; isolated TTS returned audio |
| Spanish | Yes | Yes | Selectable; isolated TTS returned audio |
| Russian | Yes | Yes | Selectable; isolated TTS returned audio |
| Polish | Yes | No | Pending; rejected explicitly and disabled in example |
| Ukrainian | Yes | No | Pending; rejected explicitly and disabled in example |
| Arabic | Yes | No | Pending; rejected explicitly and disabled in example |

Documented model coverage does not establish accent, pronunciation, code-switching or application quality. The Swedish TTS discrepancy is deliberately visible; the working path is not silently replaced or removed.

## Provider probe

An isolated probe reused the candidate's server-side credential without changing its service. It sent exact sample text through `qwen3-tts-flash-realtime`, voice `Cherry`, language `Auto`, 24 kHz PCM, matching the existing TTS configuration. One sample per language; no percentile/statistical claims. These were protocol probes, not listening tests.

| Language | Connection to session-ready (ms) | Text commit to first audio packet (ms) | Audio chunks |
| --- | ---: | ---: | ---: |
| sv | 804 | 524 | 15 |
| en | 740 | 484 | 12 |
| fr | 749 | 498 | 9 |
| es | 736 | 479 | 9 |
| ru | 744 | 521 | 11 |

These numbers exclude microphone capture, ASR, Hermes inference, sentence segmentation and audible device output. They must not be used as evidence that the 1.5–2 s warm full-chain target is achieved. They also do not measure packaging overhead.

## Local checks

Final local suite: 16 JavaScript tests and 11 Python tests passed. Python wheel/source archive and npm dry-run packaging succeeded. Browser assets were present in the wheel.

Behavioral tests cover stale run events, stop during pending submission, stopping late remote acknowledgements, immediate local interruption, transcript IDs, same-run corrections, buffered backchannels, stale TTS errors, and excluding tool/reasoning events from speech. Server tests cover authentication, per-user channel isolation, served module assets, unavailable languages and the runnable echo integration.

A browser smoke test loaded the actual local example and observed the expected missing-server-configuration error when Start was clicked, before requesting microphone access. Polish, Ukrainian and Arabic were visibly disabled. This is a UI/error-path test, not a successful voice call.

## Acceptance still required

- Run baseline and packaged build using the same authenticated agent, Qwen workspace, device, browser, phrases and network.
- Measure cold activation separately from warm turns. For each warm turn, start at the ASR speech-stop event and stop at the first audible speaker output. Use loopback/acoustic capture or explicitly report device timing limitations.
- Repeat at least ten turns per language, including interrupted answers, corrections, language changes and follow-up references to prior turns. Report sample count, median and p95.
- Have a fluent listener assess ASR accuracy and TTS intelligibility in French, Spanish and Russian, with Swedish/English regression checks.
- Verify the actual Hermes Desktop loader and its SDK event/run correlation before claiming durable-run guarantees there. The generic run-adapter tests do not establish those SDK guarantees.

The browser metric `speech_end_to_scheduled_audio_ms` includes the selected WebAudio scheduling offset. It excludes unmeasured hardware/output latency and is explicitly named accordingly. No matched baseline-versus-package acoustic comparison has been observed yet, so this package is an integration candidate, not a certified production replacement.
