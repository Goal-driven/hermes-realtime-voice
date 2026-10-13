import { VoiceController } from '/voice/client.js'
const status = document.querySelector('#status')
const transcript = document.querySelector('#transcript')
async function json(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30000),
  })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json()
}
const agent = {
  // The example server derives session ownership from an HttpOnly cookie.
  sessionId: () => 'current-authenticated-session',
  async submit({ requestId, text, language, signal, onEvent }) {
    // Let submission return its run ID even after cancellation, so it can be stopped.
    const run = await json('/agent/runs', { method: 'POST', body: { requestId, text, language } })
    const path = '/agent/runs/' + encodeURIComponent(run.id)
    const handle = {
      id: run.id,
      stop: () => json(path + '/stop', { method: 'POST', body: {} }),
      ...(run.mode === 'hermes' ? {
        redirect: (text) => json(path + '/redirect', { method: 'POST', body: { text } }),
      } : {}),
    }
    if (signal.aborted) return handle
    void (async () => {
      const response = await fetch(path + '/events', { signal, credentials: 'same-origin' })
      if (!response.ok || !response.body) throw new Error('Agent stream unavailable')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = '', terminal = false
      try {
        while (!terminal) {
          const { value, done } = await reader.read()
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
          if (buffer.length > 131072) throw new Error('Agent event too large')
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue
              const event = JSON.parse(line.slice(6))
              onEvent(event)
              if (['complete', 'error'].includes(event.type)) terminal = true
            }
          }
          if (done) break
        }
        if (!terminal && !signal.aborted) throw new Error('Agent stream ended early')
      } finally { await reader.cancel().catch(() => {}) }
    })().catch(() => { if (!signal.aborted) onEvent({ type: 'error' }) })
    return handle
  },
}
const voice = new VoiceController({
  rest: (path, options) => json('/voice' + path, options), agent,
  onState: value => { status.textContent = `${value.phase}: ${value.detail || ''}` },
  onTranscript: text => { transcript.textContent = text },
  onMetric: value => { document.querySelector('#metric').textContent = JSON.stringify(value) },
})
document.querySelector('#start').onclick = () => voice.toggle()
document.querySelector('#stop').onclick = () => voice.stop()
document.querySelector('#language').onchange = event => voice.setLanguage(event.target.value).catch(error => { status.textContent = error.message })
window.addEventListener('pagehide', () => { void voice.stop() })
