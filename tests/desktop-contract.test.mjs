import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

test('routes the final transcript to the focused Hermes session', () => {
  assert.match(source, /host\.state\.focusedSessionId\.get\(\)/)
  assert.match(source, /host\.request\('prompt\.submit'/)
  assert.match(source, /surface: 'voice'/)
  assert.match(source, /transport_only: true/)
})

test('cancels unsolicited provider responses and speaks Hermes deltas only', () => {
  assert.match(source, /if \(event\.type === 'response\.created'\)/)
  assert.match(source, /type: 'response\.cancel'/)
  assert.match(source, /event\.type === 'message\.delta'/)
  assert.match(source, /this\.ctx\.rest\('\/tts\/speak'/)
  assert.doesNotMatch(source, /type:\s*['"]response\.create['"]/)
})

test('is profile-neutral and keeps credentials out of the renderer', () => {
  assert.doesNotMatch(source.toLowerCase(), /omarchyvoicecandidate|openrouter|dashscope_api_key|qwen_api_key/)
  assert.match(source, /ctx\.rest\('\/session'/)
  assert.match(source, /\/events\/poll\?channel=/)
  assert.doesNotMatch(source, /ctx\.socket\(/)
})


test('ships a complete unified Hermes plugin package', () => {
  const manifest = JSON.parse(readFileSync(new URL('../dashboard/manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, 'hermes-realtime-voice')
  assert.equal(manifest.api, 'plugin_api.py')
  assert.equal(manifest.entry, 'dist/index.js')
  assert.doesNotThrow(() => readFileSync(new URL('../dashboard/dist/index.js', import.meta.url), 'utf8'))
})
