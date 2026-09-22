import { atom, Button, cn, haptic, host, Tip, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-realtime-voice'
const $active = atom(false)
const $phase = atom('idle')
const $detail = atom('Voice is ready to start.')
const $transcript = atom('')

class VoiceController {
  constructor(ctx) {
    this.ctx = ctx
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
    this.sessionId = null
    this.turnOpen = false
  }

  setPhase(phase, detail) {
    $phase.set(phase)
    if (detail) $detail.set(detail)
  }

  async start() {
    if ($active.get()) return
    this.setPhase('connecting', 'Preconnecting Qwen speech transport…')
    const status = await this.ctx.rest('/status')
    if (!status?.configured || status?.brain !== 'active-hermes-profile' || !status?.transport_only) {
      throw new Error('Realtime Voice backend is not configured as transport-only.')
    }
    const channel = await this.ctx.rest('/channel', { method: 'POST', body: {}, timeoutMs: 15000 })
    this.channel = channel.channel
    this.audio ||= new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 })
    await this.audio.resume()
    this.eventsRunning = true
    void this.pollEvents(this.channel)
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
    })
    const pc = new RTCPeerConnection()
    const dc = pc.createDataChannel('oai-events')
    this.pc = pc
    this.dc = dc
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream)
    pc.addEventListener('track', event => {
      event.track.enabled = false
      event.track.stop()
    })
    dc.addEventListener('message', message => {
      let event
      try { event = JSON.parse(message.data) } catch { return }
      this.onQwenEvent(event)
    })
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Qwen data channel timed out.')), 15000)
      dc.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      dc.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Qwen data channel failed.')) }, { once: true })
    })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const answer = await this.ctx.rest('/session', {
      method: 'POST', body: { sdp: offer.sdp }, timeoutMs: 30000,
    })
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    await opened
    dc.send(JSON.stringify({ type: 'session.update', session: status.session_update }))
    $active.set(true)
    this.setPhase('listening', 'Listening. Hermes remains the only reasoning agent.')
  }

  async stop() {
    $active.set(false)
    this.turnOpen = false
    this.sessionId = null
    this.queue = []
    this.tail = ''
    this.eventsRunning = false
    await this.cancelSpeech()
    if (this.channel) {
      await this.ctx.rest('/channel/close', { method: 'POST', body: { channel: this.channel } }).catch(() => {})
    }
    this.dc?.close()
    this.pc?.close()
    this.stream?.getTracks().forEach(track => track.stop())
    this.dc = null
    this.pc = null
    this.stream = null
    this.channel = null
    this.setPhase('idle', 'Voice stopped.')
  }

  async toggle() {
    try {
      if ($active.get()) await this.stop()
      else await this.start()
    } catch (error) {
      await this.stop().catch(() => {})
      this.setPhase('error', error?.message || 'Voice could not start.')
      host.notifyError(error, 'Voice could not start.')
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
    if (this.channel) {
      await this.ctx.rest('/tts/cancel', { method: 'POST', body: { channel: this.channel } }).catch(() => {})
    }
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
      if (this.currentAudio || this.queue.length) void this.cancelSpeech()
      this.turnOpen = true
      this.tail = ''
      this.setPhase('listening', 'Listening…')
      return
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.setPhase('transcribing', 'Transcribing…')
      return
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(event.transcript || '').trim()
      if (!text || !this.turnOpen) return
      this.turnOpen = false
      $transcript.set(text)
      void this.submit(text)
      return
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      this.turnOpen = false
      this.setPhase('error', 'Speech transcription failed.')
    }
  }

  async submit(text) {
    const sessionId = host.state.focusedSessionId.get()
    if (!sessionId) {
      this.setPhase('error', 'Open a Hermes conversation before starting voice.')
      return
    }
    this.sessionId = sessionId
    this.tail = ''
    this.queue = []
    this.setPhase('thinking', 'Hermes is working…')
    try {
      await host.request('prompt.submit', {
        session_id: sessionId,
        text,
        surface: 'voice',
        voice_context: { transport: 'qwen', transport_only: true, duplex: true },
      })
    } catch (error) {
      this.sessionId = null
      this.setPhase('error', error?.message || 'Hermes rejected the voice turn.')
    }
  }

  onHermesEvent(event) {
    if (!this.sessionId || event.session_id !== this.sessionId) return
    if (event.type === 'message.delta') {
      const delta = String(event.payload?.text || '')
      if (!delta) return
      this.tail += delta
      this.flushSegments(false)
      return
    }
    if (event.type === 'message.complete') {
      this.flushSegments(true)
      this.sessionId = null
      if (!this.currentAudio && !this.queue.length) this.setPhase('listening', 'Listening…')
      return
    }
    if (event.type === 'error') {
      this.sessionId = null
      this.queue = []
      this.setPhase('error', 'Hermes voice turn failed.')
    }
  }

  flushSegments(done) {
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
    void this.pump()
  }

  async pump() {
    if (this.currentAudio || !this.queue.length || !this.channel) return
    const text = this.queue.shift()
    const id = `voice:${Date.now()}:${Math.random().toString(16).slice(2)}`
    this.currentAudio = { id, text, first: false }
    this.setPhase('synthesizing', 'Preparing speech…')
    try {
      await this.ctx.rest('/tts/speak', {
        method: 'POST', body: { channel: this.channel, id, text }, timeoutMs: 10000,
      })
    } catch (error) {
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
  }
}

let controller

function VoicePane() {
  const active = useValue($active)
  const phase = useValue($phase)
  const detail = useValue($detail)
  const transcript = useValue($transcript)
  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 p-3 text-sm',
    children: [
      jsxs('div', { children: [
        jsx('div', { className: 'font-medium', children: 'Realtime Voice' }),
        jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Qwen speech transport → active Hermes profile → Qwen speech transport' }),
      ] }),
      jsx('div', { className: 'rounded-md border border-(--ui-stroke-secondary) p-2', children: `${phase}: ${detail}` }),
      transcript ? jsx('div', { className: 'text-(--ui-text-secondary)', children: `You said: ${transcript}` }) : null,
      jsx(Button, { onClick: () => void controller.toggle(), children: active ? 'Stop voice' : 'Start voice' }),
      jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: 'Hermes owns reasoning, tools and memory. Qwen receives audio for ASR and exact reply text for TTS only.' }),
    ],
  })
}

function VoiceChip() {
  const active = useValue($active)
  const phase = useValue($phase)
  return jsx(Tip, {
    label: active ? `Realtime Voice: ${phase}` : 'Start Realtime Voice',
    children: jsx('button', {
      type: 'button',
      className: cn('inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        active ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary) hover:text-foreground'),
      onClick: () => { haptic('tap'); void controller.toggle() },
      children: active ? 'voice on' : 'voice',
    }),
  })
}

export default {
  id: ID,
  name: 'Hermes Realtime Voice',
  defaultEnabled: false,
  register(ctx) {
    controller = new VoiceController(ctx)
    ctx.onEvent('*', event => controller.onHermesEvent(event))
    ctx.onDispose(() => void controller.stop())
    ctx.register({
      id: 'pane', area: 'panes', title: 'Realtime Voice',
      data: { placement: 'right', width: '300px' }, render: () => jsx(VoicePane, {}),
    })
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 125, render: () => jsx(VoiceChip, {}) })
  },
}
