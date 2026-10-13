export class VoiceController {
  constructor({ rest, agent, onState = () => {}, onTranscript = () => {}, onError = () => {}, onMetric = () => {}, language = 'sv' }) {
    this.ctx = { rest }
    this.agent = agent
    this.onState = onState
    this.onTranscript = onTranscript
    this.onError = onError
    this.onMetric = onMetric
    this.language = language
    this.active = false
    this.generation = 0
    this.run = null
    this.inputId = null
    this.cancelPending = Promise.resolve()
    this.submission = 0
    this.sessionId = null
    this.cancelSetup = null
    this.stopping = null
    this.pc = null
    this.dc = null
    this.stream = null
    this.channel = null
    this.eventsRunning = false
    this.audio = null
    this.sources = new Set()
    this.nextTime = 0
    this.currentAudio = null
    this.queue = []
    this.tail = ''
    this.turnOpen = false
  }

  setPhase(phase, detail) {
    this.onState({ active: this.active, phase, detail })
  }

  async start() {
    if (this.stopping) await this.stopping
    if (this.active) return
    this.active = true
    const generation = ++this.generation
    this.sessionId = this.agent.sessionId()
    try {
      if (!this.sessionId) throw new Error("Select an authenticated agent session first.")
      this.setPhase('connecting', 'Connecting speech transport…')
      const status = await this.ctx.rest('/status?language=' + encodeURIComponent(this.language))
      if (generation !== this.generation) return
      if (!status?.configured) throw new Error('Configure Qwen speech credentials on the server first.')
      if (!status?.transport_only) {
        throw new Error('Realtime Voice backend is not configured as transport-only.')
      }
      const channel = await this.ctx.rest('/channel', { method: 'POST', body: {}, timeoutMs: 15000 })
      if (generation !== this.generation) {
        await this.ctx.rest('/channel/close', { method: 'POST', body: { channel: channel.channel } })
        return
      }
      this.channel = channel.channel
      this.audio ||= new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 })
      await this.audio.resume()
      if (generation !== this.generation) return
      this.eventsRunning = true
      void this.pollEvents(this.channel)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
      })
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      const pc = new RTCPeerConnection()
      const dc = pc.createDataChannel('oai-events')
      this.pc = pc
      this.dc = dc
      const sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender
      pc.addEventListener('track', event => {
        event.track.enabled = false
        event.track.stop()
      })
      let configured = false
      let timer
      let finish
      const ready = new Promise((resolve, reject) => {
        finish = error => { clearTimeout(timer); error ? reject(error) : resolve() }
        timer = setTimeout(() => finish(new Error('Speech session initialization timed out.')), 15000)
      })
      this.cancelSetup = () => finish(new Error("Voice initialization cancelled."))
      // Attach a rejection handler immediately, including while SDP is in flight.
      ready.catch(() => {})
      const attach = channel => {
        channel.addEventListener('message', message => {
          if (generation !== this.generation) return
          let event
          try { event = JSON.parse(message.data) } catch { return }
          if (event.type === 'session.updated') finish()
          this.onQwenEvent(event)
        })
        channel.addEventListener('error', () => finish(new Error('Speech data channel failed.')))
        channel.addEventListener('close', () => {
          if (generation === this.generation) void this.stop()
        })
        const configure = () => {
          if (configured || generation !== this.generation) return
          configured = true
          this.dc = channel
          channel.send(JSON.stringify({ type: 'session.update', session: status.session_update }))
        }
        if (channel.readyState === 'open') configure()
        else channel.addEventListener('open', configure, { once: true })
      }
      attach(dc)
      pc.addEventListener('datachannel', event => { if (event.channel.label === 'txt') attach(event.channel) })
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const answer = await this.ctx.rest('/session', {
        method: 'POST', body: { sdp: offer.sdp, language: this.language }, timeoutMs: 30000,
      })
      if (generation !== this.generation) return
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      await ready
      if (generation !== this.generation) return
      await sender.replaceTrack(this.stream.getAudioTracks()[0])
      if (generation !== this.generation) return
      this.cancelSetup = null
      this.active = true
      this.setPhase('listening', 'Listening. Hermes remains the only reasoning agent.')
    } catch (error) {
      if (generation !== this.generation) return
      await this.stop()
      throw error
    }
  }

  stop() {
    if (this.stopping) return this.stopping
    this.active = false
    this.generation++
    this.submission++
    this.cancelSetup?.()
    this.cancelSetup = null
    this.sessionId = null
    this.endRun()
    this.turnOpen = false
    this.inputId = null
    this.queue = []
    this.tail = ''
    this.eventsRunning = false
    this.dc?.close()
    this.pc?.close()
    this.stream?.getTracks().forEach(track => track.stop())
    const channel = this.channel
    const audio = this.audio
    const cancellation = this.cancelSpeech()
    this.dc = this.pc = this.stream = this.channel = this.audio = null
    this.stopping = (async () => {
      try { await cancellation } catch { /* Closing the channel also cancels TTS. */ }
      await audio?.close()
      if (channel) await this.ctx.rest('/channel/close', { method: 'POST', body: { channel } }).catch(() => {})
      this.setPhase('idle', 'Voice stopped.')
    })().finally(() => { this.stopping = null })
    return this.stopping
  }

  async toggle() {
    try {
      if (this.active) await this.stop()
      else await this.start()
    } catch (error) {
      await this.stop().catch(() => {})
      this.setPhase('error', error?.message || 'Voice could not start.')
      this.onError(error, 'Voice could not start.')
    }
  }

  async cancelSpeech() {
    for (const source of this.sources) {
      try { source.stop() } catch {}
    }
    this.sources.clear()
    this.nextTime = this.audio?.currentTime || 0
    this.currentAudio = null
    this.queue = []
    const channel = this.channel
    this.cancelPending = this.cancelPending.catch(() => {}).then(async () => {
      if (channel) await this.ctx.rest('/tts/cancel', { method: 'POST', body: { channel } })
    })
    await this.cancelPending

  }

  async pollEvents(channel) {
    while (this.eventsRunning && this.channel === channel) {
      try {
        const event = await this.ctx.rest(`/events/poll?channel=${encodeURIComponent(channel)}`, {
          timeoutMs: 25000,
        })
        if (this.eventsRunning && this.channel === channel) this.onSpeechEvent(event)
      } catch {
        if (!this.eventsRunning || this.channel !== channel) return
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
  }

  onQwenEvent(event) {
    if (event.type === 'response.created') {
      this.dc?.send(JSON.stringify({ type: 'response.cancel' }))
      return
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      if (!this.active || this.inputId === event.item_id) return
      this.inputId = event.item_id
      if (this.run) {
        this.run.paused = true
        this.run.pending = [...(this.currentAudio ? [this.currentAudio.text] : []), ...this.queue]
        this.run.pendingTail = this.tail
      }
      void this.cancelSpeech().catch(() => this.setPhase('error', 'Speech cancellation failed.'))
      this.turnOpen = true
      this.tail = ''
      this.setPhase('listening', 'Listening…')
      return
    }
    if (event.type === 'input_audio_buffer.speech_stopped' && event.item_id === this.inputId) {
      this.speechEndedAt = performance.now()
      this.measured = false
      this.setPhase('transcribing', 'Transcribing…')
      return
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(event.transcript || '').trim()
      if (!text || !this.turnOpen || event.item_id !== this.inputId) return
      this.turnOpen = false
      this.onTranscript(text)
      if (/^(?:m+|m+h+m+|mm+\s+precis|uh[- ]?huh|right)[.!?…]*$/iu.test(text) && this.run?.paused) this.resumeRun()
      else void this.submit(text)
      return
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed' && event.item_id === this.inputId) {
      this.resumeRun()
      this.turnOpen = false
      this.setPhase('error', 'Speech transcription failed.')
    }
  }

  async submit(text) {
    if (!this.active) return
    const submission = ++this.submission
    const sessionId = this.sessionId || this.agent.sessionId()
    if (!sessionId) {
      this.setPhase('error', 'Select an authenticated agent session first.')
      return
    }
    const previous = this.run
    if (previous?.handle?.redirect && !previous.done && previous.paused) {
      clearTimeout(previous.redirectTimer)
      previous.waitingRedirect = true
      previous.buffer = []
      previous.text = text
      try {
        await previous.handle.redirect(text, this.language)
        if (this.run !== previous) return
        if (!previous.waitingRedirect) return
        previous.redirectTimer = setTimeout(() => {
          if (this.run === previous && previous.waitingRedirect) {
            this.endRun()
            void this.submit(text)
          }
        }, 5000)
        return
      } catch {
        if (this.run !== previous) return
        this.endRun()
      }
    } else this.endRun()
    try { await this.cancelSpeech() } catch { this.setPhase('error', 'Speech cancellation failed.'); return }
    if (!this.active || submission !== this.submission) return
    const turn = { requestId: crypto.randomUUID(), sessionId, buffer: [], paused: false,
      controller: new AbortController(), text, done: false }
    this.run = turn
    this.tail = ''
    this.setPhase('thinking', 'The agent is working…')
    try {
      const handle = await this.agent.submit({
        sessionId, requestId: turn.requestId, text, language: this.language,
        signal: turn.controller.signal,
        onEvent: event => this.onAgentEvent(turn, event),
      })
      if (this.run !== turn) { await handle?.stop?.(); return }
      turn.handle = handle
    } catch (error) {
      if (this.run !== turn) return
      this.endRun()
      this.setPhase('error', error?.message || 'The agent rejected the voice turn.')
    }
  }

  endRun() {
    const turn = this.run
    this.run = null
    clearTimeout(turn?.redirectTimer)
    turn?.controller.abort()
    if (turn?.handle?.stop && !turn.done) {
      Promise.resolve().then(() => turn.handle.stop()).catch(() => {
        this.onError(new Error('The agent run could not be stopped.'))
      })
    }
  }

  onAgentEvent(turn, event) {
    if (this.run !== turn || !this.active) return
    if (event.type === 'redirected') {
      if (!turn.waitingRedirect) return
      clearTimeout(turn.redirectTimer)
      turn.waitingRedirect = false
      turn.paused = false
      turn.buffer = []
      this.tail = ''
      return
    }
    if (turn.waitingRedirect) {
      if (['complete', 'error'].includes(event.type)) {
        const text = turn.text
        this.endRun()
        void this.submit(text)
      }
      return
    }
    if (turn.paused) {
      if (turn.buffer.length >= 256) { this.endRun(); this.setPhase('error', 'Paused response exceeded its buffer.'); return }
      turn.buffer.push(event); return
    }
    if (event.type === 'text' && typeof event.text === 'string') {
      this.tail += event.text
      this.flushSegments(false)
    } else if (event.type === 'complete') {
      turn.done = true
      this.flushSegments(true)
    } else if (event.type === 'error') {
      this.endRun()
      void this.cancelSpeech().catch(() => this.setPhase('error', 'Speech cancellation failed.'))
      this.setPhase('error', 'The agent voice turn failed.')
    }
  }

  resumeRun() {
    const turn = this.run
    if (!turn) return
    turn.paused = false
    this.queue = turn.pending || []
    this.tail = turn.pendingTail || ''
    for (const event of turn.buffer.splice(0)) this.onAgentEvent(turn, event)
    void this.pump()
  }

  async setLanguage(language) {
    if (!['sv', 'en', 'fr', 'pl', 'es', 'uk', 'ru', 'ar'].includes(language)) {
      throw new Error('Unknown language')
    }
    const status = await this.ctx.rest('/status?language=' + encodeURIComponent(language))
    if (this.dc?.readyState === 'open') {
      const { turn_detection, input_audio_format, output_audio_format, input_audio_transcription, voice, ...live } = status.session_update
      this.dc.send(JSON.stringify({ type: 'session.update', session: live }))
    }
    this.language = language
  }

  flushSegments(done) {
    // Keep provider input bounded even for long unpunctuated text.
    while (this.tail.length > 2000) {
      const space = this.tail.lastIndexOf(' ', 2000)
      let split = space > 0 ? space : 2000
      const code = this.tail.charCodeAt(split - 1)
      if (code >= 0xD800 && code <= 0xDBFF) split--
      this.queue.push(this.tail.slice(0, split))
      this.tail = this.tail.slice(split)
    }
    let boundary
    while ((boundary = this.tail.search(/(?<=[^0-9])[.!?](?:\s|$)|\n/)) !== -1) {
      const text = this.tail.slice(0, boundary + 1).trim()
      this.tail = this.tail.slice(boundary + 1)
      if (text) this.queue.push(text)
    }
    if (this.tail.length >= 48) {
      const split = this.tail.indexOf(' ', 32)
      if (split >= 0) {
        this.queue.push(this.tail.slice(0, split + 1).trim())
        this.tail = this.tail.slice(split + 1)
      }
    }
    if (done && this.tail.trim()) {
      this.queue.push(this.tail.trim())
      this.tail = ''
    }
    if (this.queue.length > 256) {
      this.endRun()
      void this.cancelSpeech().catch(() => {})
      this.setPhase('error', 'Answer exceeded the speech queue limit.')
      return
    }
    void this.pump()
  }

  async pump() {
    try { await this.cancelPending } catch { this.setPhase('error', 'Speech cancellation failed.'); return }
    if (!this.active || this.run?.paused || this.currentAudio || !this.queue.length || !this.channel) return
    const text = this.queue.shift()
    const id = `voice:${Date.now()}:${Math.random().toString(16).slice(2)}`
    const item = { id, text, first: false }
    this.currentAudio = item
    this.setPhase('synthesizing', 'Preparing speech…')
    try {
      await this.ctx.rest('/tts/speak', {
        method: 'POST', body: { channel: this.channel, id, text, language: this.language }, timeoutMs: 10000,
      })
    } catch (error) {
      if (this.currentAudio !== item) return
      this.currentAudio = null
      this.queue = []
      this.setPhase('error', error?.message || 'Speech synthesis failed.')
    }
  }

  onSpeechEvent(event) {
    if (event.type === 'ready') return
    if (!this.currentAudio || event.id !== this.currentAudio.id) return
    if (event.type === 'audio') {
      this.play(event.delta)
      if (!this.currentAudio.first) {
        this.currentAudio.first = true
        this.setPhase('speaking', 'Speaking. You can interrupt at any time.')
      }
      return
    }
    if (event.type === 'done') {
      const item = this.currentAudio
      const delay = Math.max(0, (this.nextTime - this.audio.currentTime) * 1000)
      setTimeout(() => {
        if (this.currentAudio !== item) return
        this.currentAudio = null
        if (this.queue.length) void this.pump()
        else this.setPhase('listening', 'Listening…')
      }, delay + 20)
      return
    }
    if (event.type === 'error') {
      this.currentAudio = null
      this.queue = []
      this.setPhase('error', event.message || 'Speech synthesis failed.')
    }
  }

  play(encoded) {
    let binary
    try { binary = atob(encoded) } catch { return }
    const count = Math.floor(binary.length / 2)
    const samples = new Float32Array(count)
    for (let index = 0; index < count; index++) {
      const lo = binary.charCodeAt(index * 2)
      const hi = binary.charCodeAt(index * 2 + 1)
      let value = (hi << 8) | lo
      if (value & 0x8000) value -= 0x10000
      samples[index] = value / 32768
    }
    const buffer = this.audio.createBuffer(1, count, 24000)
    buffer.copyToChannel(samples, 0)
    const source = this.audio.createBufferSource()
    source.buffer = buffer
    source.connect(this.audio.destination)
    const start = Math.max(this.audio.currentTime + 0.015, this.nextTime)
    this.nextTime = start + buffer.duration
    this.sources.add(source)
    source.addEventListener('ended', () => this.sources.delete(source), { once: true })
    source.start(start)
    if (!this.measured && this.speechEndedAt) {
      this.measured = true
      this.onMetric({ name: 'speech_end_to_scheduled_audio_ms',
        durationMs: performance.now() - this.speechEndedAt + (start - this.audio.currentTime) * 1000,
        language: this.language, requestId: this.run?.requestId,
        measurement: 'browser-scheduled; excludes unmeasured device/output latency' })
    }
  }
}
