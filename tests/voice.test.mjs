import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceController } from '../hermes_realtime_voice/browser/voice.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(overrides = {}) {
  const submitted = [], calls = [], states = []
  const voice = new VoiceController({
    rest: async (path, options) => { calls.push({ path, ...options }); return {} },
    agent: { sessionId: () => 'session-a', submit: async turn => { submitted.push(turn); return { stop() {} } }, ...overrides },
    onState: state => states.push(state),
  })
  voice.active = true
  voice.channel = 'test-channel'
  return { voice, submitted, calls, states }
}

test('only the current run can enqueue agent text, even in the same session', async () => {
  const { voice, submitted } = fixture()
  await voice.submit('first')
  await voice.submit('second')
  submitted[0].onEvent({ type: 'text', text: 'Stale answer.' })
  assert.equal(voice.tail, '')
  submitted[1].onEvent({ type: 'text', text: 'Current answer' })
  assert.equal(voice.tail, 'Current answer')
  assert.equal(submitted[0].signal.aborted, true)
  voice.endRun()
})

test('stop while cancellation is in flight cannot submit a new agent run', async () => {
  let release
  const { voice, submitted } = fixture()
  voice.cancelPending = new Promise(resolve => { release = resolve })
  const pending = voice.submit('hello')
  const stopping = voice.stop()
  release()
  await Promise.all([pending, stopping])
  assert.equal(submitted.length, 0)
  assert.equal(voice.run, null)
})

test('late submit acknowledgement stops the superseded remote run', async () => {
  let acknowledge, stopped = 0
  const { voice } = fixture({ submit: () => new Promise(resolve => { acknowledge = resolve }) })
  const pending = voice.submit('hello')
  await tick()
  await voice.stop()
  acknowledge({ stop: async () => { stopped++ } })
  await pending
  assert.equal(stopped, 1)
})

test('speech keeps input open and stops local output before remote cancellation', async () => {
  const { voice } = fixture()
  let stopped = false
  voice.sources.add({ stop() { stopped = true } })
  voice.currentAudio = { id: 'old', text: 'old' }
  voice.onQwenEvent({ type: 'input_audio_buffer.speech_started', item_id: 'input-a' })
  assert.equal(stopped, true)
  assert.equal(voice.turnOpen, true)
  assert.equal(voice.active, true)
  assert.equal(voice.currentAudio, null)
  await voice.cancelPending
})

test('transcript IDs prevent a late older transcript from replacing the latest input', async () => {
  const { voice, submitted } = fixture()
  voice.onQwenEvent({ type: 'input_audio_buffer.speech_started', item_id: 'old' })
  voice.onQwenEvent({ type: 'input_audio_buffer.speech_started', item_id: 'new' })
  voice.onQwenEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: 'old words' })
  voice.onQwenEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new', transcript: 'new words' })
  await tick()
  assert.deepEqual(submitted.map(turn => turn.text), ['new words'])
  voice.endRun()
})

test('correction uses the same run and discards text before redirect acknowledgement', async () => {
  let redirected
  const { voice, submitted } = fixture({ submit: async turn => { submitted.push(turn); return { redirect: async text => { redirected = text }, stop() {} } } })
  await voice.submit('first')
  const original = voice.run
  voice.onQwenEvent({ type: 'input_audio_buffer.speech_started', item_id: 'correction' })
  await voice.submit('corrected question')
  submitted[0].onEvent({ type: 'text', text: 'Old response' })
  assert.equal(voice.tail, '')
  submitted[0].onEvent({ type: 'redirected' })
  submitted[0].onEvent({ type: 'text', text: 'Corrected response' })
  assert.equal(voice.run, original)
  assert.equal(redirected, 'corrected question')
  assert.equal(voice.tail, 'Corrected response')
  voice.endRun()
})

test('backchannel resumes buffered response without creating another run', async () => {
  const { voice, submitted } = fixture()
  await voice.submit('first')
  submitted[0].onEvent({ type: 'text', text: 'Part one ' })
  voice.onQwenEvent({ type: 'input_audio_buffer.speech_started', item_id: 'backchannel' })
  submitted[0].onEvent({ type: 'text', text: 'part two' })
  voice.onQwenEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'backchannel', transcript: 'mm' })
  assert.equal(submitted.length, 1)
  assert.equal(voice.tail, 'Part one part two')
  voice.endRun()
})

test('late TTS errors cannot clear the new playback item', async () => {
  const { voice } = fixture()
  let reject
  voice.ctx.rest = () => new Promise((_, fail) => { reject = fail })
  voice.queue = ['old']
  const pending = voice.pump()
  await tick()
  const current = { id: 'new' }
  voice.currentAudio = current
  reject(new Error('old failed'))
  await pending
  assert.equal(voice.currentAudio, current)
})

test('tool and reasoning events never enter speech synthesis', async () => {
  const { voice, submitted, calls } = fixture()
  await voice.submit('test')
  submitted[0].onEvent({ type: 'tool', text: 'private tool result' })
  submitted[0].onEvent({ type: 'reasoning', text: 'private reasoning' })
  await tick()
  assert.equal(voice.tail, '')
  assert.equal(calls.some(call => call.path === '/tts/speak'), false)
  voice.endRun()
})

test('unsolicited speech-provider answers are cancelled', () => {
  const { voice } = fixture()
  const events = []
  voice.dc = { send: value => events.push(JSON.parse(value)) }
  voice.onQwenEvent({ type: 'response.created' })
  assert.deepEqual(events, [{ type: 'response.cancel' }])
})


test('a pinned conversation remains stable when host focus changes', async () => {
  const { voice, submitted } = fixture({ sessionId: () => 'new-focus' })
  voice.sessionId = 'voice-conversation'
  await voice.submit('follow-up')
  assert.equal(submitted[0].sessionId, 'voice-conversation')
  voice.endRun()
})

test('long unpunctuated answers stay below the TTS request limit', () => {
  const { voice } = fixture()
  voice.channel = null
  voice.tail = 'a'.repeat(10001)
  voice.flushSegments(true)
  assert.equal(voice.queue.join(''), 'a'.repeat(10001))
  assert.ok(voice.queue.every(segment => segment.length <= 2000))
})
