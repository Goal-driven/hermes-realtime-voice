import { atom, Button, cn, haptic, host, Tip, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-realtime-voice'
const $active = atom(false)
const $phase = atom('idle')
const $detail = atom('Voice is ready to start.')
const $transcript = atom('')

// The SDK has session-scoped events. Hosts with durable runs should use the
// request-scoped adapter documented in docs/INTEGRATION.md instead.
import { VoiceController } from '../hermes_realtime_voice/browser/voice.js'

function desktopAgent(ctx) {
  return {
    sessionId: () => host.state.focusedSessionId.get(),
    async submit({ sessionId, text, signal, onEvent }) {
      let live = true
      const unsubscribe = ctx.onEvent('*', event => {
        if (!live || signal.aborted || event.session_id !== sessionId) return
        if (event.type === 'message.delta') onEvent({ type: 'text', text: event.payload?.text })
        if (event.type === 'message.complete') { onEvent({ type: 'complete' }); stop() }
        if (event.type === 'error') { onEvent({ type: 'error' }); stop() }
      })
      const stop = () => { live = false; if (typeof unsubscribe === 'function') unsubscribe() }
      signal.addEventListener('abort', stop, { once: true })
      try {
        await host.request('prompt.submit', {
          session_id: sessionId, text, surface: 'voice',
          voice_context: { transport: 'qwen', transport_only: true, duplex: true },
        })
      } catch (error) { stop(); throw error }
      return { stop }
    },
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
    controller = new VoiceController({
      rest: (...args) => ctx.rest(...args), agent: desktopAgent(ctx),
      onState: ({ active, phase, detail }) => { $active.set(active); $phase.set(phase); if (detail) $detail.set(detail) },
      onTranscript: text => $transcript.set(text),
      onError: error => host.notifyError(error, 'Voice could not start.'),
    })
    ctx.onDispose(() => void controller.stop())
    ctx.register({
      id: 'pane', area: 'panes', title: 'Realtime Voice',
      data: { placement: 'right', width: '300px' }, render: () => jsx(VoicePane, {}),
    })
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 125, render: () => jsx(VoiceChip, {}) })
  },
}
