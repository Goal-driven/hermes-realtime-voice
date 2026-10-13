// desktop/entry.js
import { atom, Button, cn, haptic, host, Tip, useValue } from "@hermes/plugin-sdk";
import { jsx, jsxs } from "react/jsx-runtime";

// hermes_realtime_voice/browser/voice.js
var VoiceController = class {
  constructor({ rest, agent, onState = () => {
  }, onTranscript = () => {
  }, onError = () => {
  }, onMetric = () => {
  }, language = "sv" }) {
    this.ctx = { rest };
    this.agent = agent;
    this.onState = onState;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.onMetric = onMetric;
    this.language = language;
    this.active = false;
    this.generation = 0;
    this.run = null;
    this.inputId = null;
    this.cancelPending = Promise.resolve();
    this.submission = 0;
    this.sessionId = null;
    this.cancelSetup = null;
    this.stopping = null;
    this.pc = null;
    this.dc = null;
    this.stream = null;
    this.channel = null;
    this.eventsRunning = false;
    this.audio = null;
    this.sources = /* @__PURE__ */ new Set();
    this.nextTime = 0;
    this.currentAudio = null;
    this.queue = [];
    this.tail = "";
    this.turnOpen = false;
  }
  setPhase(phase, detail) {
    this.onState({ active: this.active, phase, detail });
  }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    this.sessionId = this.agent.sessionId();
    try {
      if (!this.sessionId) throw new Error("Select an authenticated agent session first.");
      this.setPhase("connecting", "Connecting speech transport\u2026");
      const status = await this.ctx.rest("/status?language=" + encodeURIComponent(this.language));
      if (generation !== this.generation) return;
      if (!status?.configured) throw new Error("Configure Qwen speech credentials on the server first.");
      if (!status?.transport_only) {
        throw new Error("Realtime Voice backend is not configured as transport-only.");
      }
      const channel = await this.ctx.rest("/channel", { method: "POST", body: {}, timeoutMs: 15e3 });
      if (generation !== this.generation) {
        await this.ctx.rest("/channel/close", { method: "POST", body: { channel: channel.channel } });
        return;
      }
      this.channel = channel.channel;
      this.audio ||= new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24e3 });
      await this.audio.resume();
      if (generation !== this.generation) return;
      this.eventsRunning = true;
      void this.pollEvents(this.channel);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 }
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel("oai-events");
      this.pc = pc;
      this.dc = dc;
      const sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
      pc.addEventListener("track", (event) => {
        event.track.enabled = false;
        event.track.stop();
      });
      let configured = false;
      let timer;
      let finish;
      const ready = new Promise((resolve, reject) => {
        finish = (error) => {
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        timer = setTimeout(() => finish(new Error("Speech session initialization timed out.")), 15e3);
      });
      this.cancelSetup = () => finish(new Error("Voice initialization cancelled."));
      ready.catch(() => {
      });
      const attach = (channel2) => {
        channel2.addEventListener("message", (message) => {
          if (generation !== this.generation) return;
          let event;
          try {
            event = JSON.parse(message.data);
          } catch {
            return;
          }
          if (event.type === "session.updated") finish();
          this.onQwenEvent(event);
        });
        channel2.addEventListener("error", () => finish(new Error("Speech data channel failed.")));
        channel2.addEventListener("close", () => {
          if (generation === this.generation) void this.stop();
        });
        const configure = () => {
          if (configured || generation !== this.generation) return;
          configured = true;
          this.dc = channel2;
          channel2.send(JSON.stringify({ type: "session.update", session: status.session_update }));
        };
        if (channel2.readyState === "open") configure();
        else channel2.addEventListener("open", configure, { once: true });
      };
      attach(dc);
      pc.addEventListener("datachannel", (event) => {
        if (event.channel.label === "txt") attach(event.channel);
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await this.ctx.rest("/session", {
        method: "POST",
        body: { sdp: offer.sdp, language: this.language },
        timeoutMs: 3e4
      });
      if (generation !== this.generation) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await ready;
      if (generation !== this.generation) return;
      await sender.replaceTrack(this.stream.getAudioTracks()[0]);
      if (generation !== this.generation) return;
      this.cancelSetup = null;
      this.active = true;
      this.setPhase("listening", "Listening. Hermes remains the only reasoning agent.");
    } catch (error) {
      if (generation !== this.generation) return;
      await this.stop();
      throw error;
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.active = false;
    this.generation++;
    this.submission++;
    this.cancelSetup?.();
    this.cancelSetup = null;
    this.sessionId = null;
    this.endRun();
    this.turnOpen = false;
    this.inputId = null;
    this.queue = [];
    this.tail = "";
    this.eventsRunning = false;
    this.dc?.close();
    this.pc?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    const channel = this.channel;
    const audio = this.audio;
    const cancellation = this.cancelSpeech();
    this.dc = this.pc = this.stream = this.channel = this.audio = null;
    this.stopping = (async () => {
      try {
        await cancellation;
      } catch {
      }
      await audio?.close();
      if (channel) await this.ctx.rest("/channel/close", { method: "POST", body: { channel } }).catch(() => {
      });
      this.setPhase("idle", "Voice stopped.");
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  async toggle() {
    try {
      if (this.active) await this.stop();
      else await this.start();
    } catch (error) {
      await this.stop().catch(() => {
      });
      this.setPhase("error", error?.message || "Voice could not start.");
      this.onError(error, "Voice could not start.");
    }
  }
  async cancelSpeech() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
      }
    }
    this.sources.clear();
    this.nextTime = this.audio?.currentTime || 0;
    this.currentAudio = null;
    this.queue = [];
    const channel = this.channel;
    this.cancelPending = this.cancelPending.catch(() => {
    }).then(async () => {
      if (channel) await this.ctx.rest("/tts/cancel", { method: "POST", body: { channel } });
    });
    await this.cancelPending;
  }
  async pollEvents(channel) {
    while (this.eventsRunning && this.channel === channel) {
      try {
        const event = await this.ctx.rest(`/events/poll?channel=${encodeURIComponent(channel)}`, {
          timeoutMs: 25e3
        });
        if (this.eventsRunning && this.channel === channel) this.onSpeechEvent(event);
      } catch {
        if (!this.eventsRunning || this.channel !== channel) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  onQwenEvent(event) {
    if (event.type === "response.created") {
      this.dc?.send(JSON.stringify({ type: "response.cancel" }));
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      if (!this.active || this.inputId === event.item_id) return;
      this.inputId = event.item_id;
      if (this.run) {
        this.run.paused = true;
        this.run.pending = [...this.currentAudio ? [this.currentAudio.text] : [], ...this.queue];
        this.run.pendingTail = this.tail;
      }
      void this.cancelSpeech().catch(() => this.setPhase("error", "Speech cancellation failed."));
      this.turnOpen = true;
      this.tail = "";
      this.setPhase("listening", "Listening\u2026");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped" && event.item_id === this.inputId) {
      this.speechEndedAt = performance.now();
      this.measured = false;
      this.setPhase("transcribing", "Transcribing\u2026");
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = String(event.transcript || "").trim();
      if (!text || !this.turnOpen || event.item_id !== this.inputId) return;
      this.turnOpen = false;
      this.onTranscript(text);
      if (/^(?:m+|m+h+m+|mm+\s+precis|uh[- ]?huh|right)[.!?…]*$/iu.test(text) && this.run?.paused) this.resumeRun();
      else void this.submit(text);
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed" && event.item_id === this.inputId) {
      this.resumeRun();
      this.turnOpen = false;
      this.setPhase("error", "Speech transcription failed.");
    }
  }
  async submit(text) {
    if (!this.active) return;
    const submission = ++this.submission;
    const sessionId = this.sessionId || this.agent.sessionId();
    if (!sessionId) {
      this.setPhase("error", "Select an authenticated agent session first.");
      return;
    }
    const previous = this.run;
    if (previous?.handle?.redirect && !previous.done && previous.paused) {
      clearTimeout(previous.redirectTimer);
      previous.waitingRedirect = true;
      previous.buffer = [];
      previous.text = text;
      try {
        await previous.handle.redirect(text, this.language);
        if (this.run !== previous) return;
        if (!previous.waitingRedirect) return;
        previous.redirectTimer = setTimeout(() => {
          if (this.run === previous && previous.waitingRedirect) {
            this.endRun();
            void this.submit(text);
          }
        }, 5e3);
        return;
      } catch {
        if (this.run !== previous) return;
        this.endRun();
      }
    } else this.endRun();
    try {
      await this.cancelSpeech();
    } catch {
      this.setPhase("error", "Speech cancellation failed.");
      return;
    }
    if (!this.active || submission !== this.submission) return;
    const turn = {
      requestId: crypto.randomUUID(),
      sessionId,
      buffer: [],
      paused: false,
      controller: new AbortController(),
      text,
      done: false
    };
    this.run = turn;
    this.tail = "";
    this.setPhase("thinking", "The agent is working\u2026");
    try {
      const handle = await this.agent.submit({
        sessionId,
        requestId: turn.requestId,
        text,
        language: this.language,
        signal: turn.controller.signal,
        onEvent: (event) => this.onAgentEvent(turn, event)
      });
      if (this.run !== turn) {
        await handle?.stop?.();
        return;
      }
      turn.handle = handle;
    } catch (error) {
      if (this.run !== turn) return;
      this.endRun();
      this.setPhase("error", error?.message || "The agent rejected the voice turn.");
    }
  }
  endRun() {
    const turn = this.run;
    this.run = null;
    clearTimeout(turn?.redirectTimer);
    turn?.controller.abort();
    if (turn?.handle?.stop && !turn.done) {
      Promise.resolve().then(() => turn.handle.stop()).catch(() => {
        this.onError(new Error("The agent run could not be stopped."));
      });
    }
  }
  onAgentEvent(turn, event) {
    if (this.run !== turn || !this.active) return;
    if (event.type === "redirected") {
      if (!turn.waitingRedirect) return;
      clearTimeout(turn.redirectTimer);
      turn.waitingRedirect = false;
      turn.paused = false;
      turn.buffer = [];
      this.tail = "";
      return;
    }
    if (turn.waitingRedirect) {
      if (["complete", "error"].includes(event.type)) {
        const text = turn.text;
        this.endRun();
        void this.submit(text);
      }
      return;
    }
    if (turn.paused) {
      if (turn.buffer.length >= 256) {
        this.endRun();
        this.setPhase("error", "Paused response exceeded its buffer.");
        return;
      }
      turn.buffer.push(event);
      return;
    }
    if (event.type === "text" && typeof event.text === "string") {
      this.tail += event.text;
      this.flushSegments(false);
    } else if (event.type === "complete") {
      turn.done = true;
      this.flushSegments(true);
    } else if (event.type === "error") {
      this.endRun();
      void this.cancelSpeech().catch(() => this.setPhase("error", "Speech cancellation failed."));
      this.setPhase("error", "The agent voice turn failed.");
    }
  }
  resumeRun() {
    const turn = this.run;
    if (!turn) return;
    turn.paused = false;
    this.queue = turn.pending || [];
    this.tail = turn.pendingTail || "";
    for (const event of turn.buffer.splice(0)) this.onAgentEvent(turn, event);
    void this.pump();
  }
  async setLanguage(language) {
    if (!["sv", "en", "fr", "pl", "es", "uk", "ru", "ar"].includes(language)) {
      throw new Error("Unknown language");
    }
    const status = await this.ctx.rest("/status?language=" + encodeURIComponent(language));
    if (this.dc?.readyState === "open") {
      const { turn_detection, input_audio_format, output_audio_format, input_audio_transcription, voice, ...live } = status.session_update;
      this.dc.send(JSON.stringify({ type: "session.update", session: live }));
    }
    this.language = language;
  }
  flushSegments(done) {
    while (this.tail.length > 2e3) {
      const space = this.tail.lastIndexOf(" ", 2e3);
      let split = space > 0 ? space : 2e3;
      const code = this.tail.charCodeAt(split - 1);
      if (code >= 55296 && code <= 56319) split--;
      this.queue.push(this.tail.slice(0, split));
      this.tail = this.tail.slice(split);
    }
    let boundary;
    while ((boundary = this.tail.search(/(?<=[^0-9])[.!?](?:\s|$)|\n/)) !== -1) {
      const text = this.tail.slice(0, boundary + 1).trim();
      this.tail = this.tail.slice(boundary + 1);
      if (text) this.queue.push(text);
    }
    if (this.tail.length >= 48) {
      const split = this.tail.indexOf(" ", 32);
      if (split >= 0) {
        this.queue.push(this.tail.slice(0, split + 1).trim());
        this.tail = this.tail.slice(split + 1);
      }
    }
    if (done && this.tail.trim()) {
      this.queue.push(this.tail.trim());
      this.tail = "";
    }
    if (this.queue.length > 256) {
      this.endRun();
      void this.cancelSpeech().catch(() => {
      });
      this.setPhase("error", "Answer exceeded the speech queue limit.");
      return;
    }
    void this.pump();
  }
  async pump() {
    try {
      await this.cancelPending;
    } catch {
      this.setPhase("error", "Speech cancellation failed.");
      return;
    }
    if (!this.active || this.run?.paused || this.currentAudio || !this.queue.length || !this.channel) return;
    const text = this.queue.shift();
    const id = `voice:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const item = { id, text, first: false };
    this.currentAudio = item;
    this.setPhase("synthesizing", "Preparing speech\u2026");
    try {
      await this.ctx.rest("/tts/speak", {
        method: "POST",
        body: { channel: this.channel, id, text, language: this.language },
        timeoutMs: 1e4
      });
    } catch (error) {
      if (this.currentAudio !== item) return;
      this.currentAudio = null;
      this.queue = [];
      this.setPhase("error", error?.message || "Speech synthesis failed.");
    }
  }
  onSpeechEvent(event) {
    if (event.type === "ready") return;
    if (!this.currentAudio || event.id !== this.currentAudio.id) return;
    if (event.type === "audio") {
      this.play(event.delta);
      if (!this.currentAudio.first) {
        this.currentAudio.first = true;
        this.setPhase("speaking", "Speaking. You can interrupt at any time.");
      }
      return;
    }
    if (event.type === "done") {
      const item = this.currentAudio;
      const delay = Math.max(0, (this.nextTime - this.audio.currentTime) * 1e3);
      setTimeout(() => {
        if (this.currentAudio !== item) return;
        this.currentAudio = null;
        if (this.queue.length) void this.pump();
        else this.setPhase("listening", "Listening\u2026");
      }, delay + 20);
      return;
    }
    if (event.type === "error") {
      this.currentAudio = null;
      this.queue = [];
      this.setPhase("error", event.message || "Speech synthesis failed.");
    }
  }
  play(encoded) {
    let binary;
    try {
      binary = atob(encoded);
    } catch {
      return;
    }
    const count = Math.floor(binary.length / 2);
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      const lo = binary.charCodeAt(index * 2);
      const hi = binary.charCodeAt(index * 2 + 1);
      let value = hi << 8 | lo;
      if (value & 32768) value -= 65536;
      samples[index] = value / 32768;
    }
    const buffer = this.audio.createBuffer(1, count, 24e3);
    buffer.copyToChannel(samples, 0);
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audio.destination);
    const start = Math.max(this.audio.currentTime + 0.015, this.nextTime);
    this.nextTime = start + buffer.duration;
    this.sources.add(source);
    source.addEventListener("ended", () => this.sources.delete(source), { once: true });
    source.start(start);
    if (!this.measured && this.speechEndedAt) {
      this.measured = true;
      this.onMetric({
        name: "speech_end_to_scheduled_audio_ms",
        durationMs: performance.now() - this.speechEndedAt + (start - this.audio.currentTime) * 1e3,
        language: this.language,
        requestId: this.run?.requestId,
        measurement: "browser-scheduled; excludes unmeasured device/output latency"
      });
    }
  }
};

// desktop/entry.js
var ID = "hermes-realtime-voice";
var $active = atom(false);
var $phase = atom("idle");
var $detail = atom("Voice is ready to start.");
var $transcript = atom("");
function desktopAgent(ctx) {
  return {
    sessionId: () => host.state.focusedSessionId.get(),
    async submit({ sessionId, text, signal, onEvent }) {
      let live = true;
      const unsubscribe = ctx.onEvent("*", (event) => {
        if (!live || signal.aborted || event.session_id !== sessionId) return;
        if (event.type === "message.delta") onEvent({ type: "text", text: event.payload?.text });
        if (event.type === "message.complete") {
          onEvent({ type: "complete" });
          stop();
        }
        if (event.type === "error") {
          onEvent({ type: "error" });
          stop();
        }
      });
      const stop = () => {
        live = false;
        if (typeof unsubscribe === "function") unsubscribe();
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        await host.request("prompt.submit", {
          session_id: sessionId,
          text,
          surface: "voice",
          voice_context: { transport: "qwen", transport_only: true, duplex: true }
        });
      } catch (error) {
        stop();
        throw error;
      }
      return { stop };
    }
  };
}
var controller;
function VoicePane() {
  const active = useValue($active);
  const phase = useValue($phase);
  const detail = useValue($detail);
  const transcript = useValue($transcript);
  return jsxs("div", {
    className: "flex h-full flex-col gap-3 p-3 text-sm",
    children: [
      jsxs("div", { children: [
        jsx("div", { className: "font-medium", children: "Realtime Voice" }),
        jsx("div", { className: "text-(--ui-text-tertiary)", children: "Qwen speech transport \u2192 active Hermes profile \u2192 Qwen speech transport" })
      ] }),
      jsx("div", { className: "rounded-md border border-(--ui-stroke-secondary) p-2", children: `${phase}: ${detail}` }),
      transcript ? jsx("div", { className: "text-(--ui-text-secondary)", children: `You said: ${transcript}` }) : null,
      jsx(Button, { onClick: () => void controller.toggle(), children: active ? "Stop voice" : "Start voice" }),
      jsx("div", { className: "text-xs text-(--ui-text-quaternary)", children: "Hermes owns reasoning, tools and memory. Qwen receives audio for ASR and exact reply text for TTS only." })
    ]
  });
}
function VoiceChip() {
  const active = useValue($active);
  const phase = useValue($phase);
  return jsx(Tip, {
    label: active ? `Realtime Voice: ${phase}` : "Start Realtime Voice",
    children: jsx("button", {
      type: "button",
      className: cn(
        "inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors",
        active ? "text-(--ui-accent)" : "text-(--ui-text-tertiary) hover:text-foreground"
      ),
      onClick: () => {
        haptic("tap");
        void controller.toggle();
      },
      children: active ? "voice on" : "voice"
    })
  });
}
var entry_default = {
  id: ID,
  name: "Hermes Realtime Voice",
  defaultEnabled: false,
  register(ctx) {
    controller = new VoiceController({
      rest: (...args) => ctx.rest(...args),
      agent: desktopAgent(ctx),
      onState: ({ active, phase, detail }) => {
        $active.set(active);
        $phase.set(phase);
        if (detail) $detail.set(detail);
      },
      onTranscript: (text) => $transcript.set(text),
      onError: (error) => host.notifyError(error, "Voice could not start.")
    });
    ctx.onDispose(() => void controller.stop());
    ctx.register({
      id: "pane",
      area: "panes",
      title: "Realtime Voice",
      data: { placement: "right", width: "300px" },
      render: () => jsx(VoicePane, {})
    });
    ctx.register({ id: "chip", area: "statusBar.right", order: 125, render: () => jsx(VoiceChip, {}) });
  }
};
export {
  entry_default as default
};
