# Security policy

Report vulnerabilities privately through GitHub Security Advisories for this repository.

The plugin enforces these boundaries:

- Qwen credentials remain backend-only.
- Qwen endpoints must be HTTPS/WSS hosts under `aliyuncs.com`.
- SDP, request IDs and TTS text are bounded and validated.
- Each desktop connection gets an unguessable channel token.
- TTS receives only exact Hermes response text.
- The speech provider receives no Hermes credentials, system prompt, tools, memory, hidden reasoning or stored history.
- The desktop plugin is opt-in and the Python backend still requires Hermes' `plugins.enabled` gate.

Voice and voiceprint signals are not authentication and must not authorize sensitive actions.
