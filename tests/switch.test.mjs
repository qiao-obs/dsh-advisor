/**
 * The master switch.
 *
 * Two things have to be true for "off" to mean off, and they fail separately:
 *
 * 1. The preference survives a round trip. A switch that silently reverts to on
 *    after a restart is worse than no switch, because the person believes the
 *    feature is gone and stops watching for it.
 * 2. The service refuses before it spends anything. Reading materials or
 *    calling a model and then discarding the answer would still cost money and
 *    still touch the workspace, which is exactly what turning it off was meant
 *    to prevent.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createConsultService } from '../lib/consult.js'
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  normalizeSettings,
} from '../lib/settings.js'

const SESSION = 'session-switch-test'

test('the switch defaults to on so an upgrade does not silently change behaviour', () => {
  const normalized = normalizeSettings({})
  assert.equal(normalized.enabled, true)

  // A settings file written before the switch existed has no such key at all.
  const fromDisk = normalizeSettings({ mode: 'manual', delivery: 'show' })
  assert.equal(fromDisk.enabled, true)
})

test('off survives normalization, which is what writes it back to disk', () => {
  assert.equal(normalizeSettings({ enabled: false }).enabled, false)
})

test('a non-boolean value falls back to the default instead of coercing', () => {
  // Hand-edited files are a real source of these. `"false"` is truthy, and a
  // settings loader that trusted it would turn the switch back on.
  assert.equal(normalizeSettings({ enabled: 'false' }).enabled, true)
  assert.equal(normalizeSettings({ enabled: 0 }).enabled, true)
  assert.equal(normalizeSettings({ enabled: null }).enabled, true)
})

test('a patch toggles the switch without disturbing the other preferences', () => {
  const before = normalizeSettings({
    ...DEFAULT_SETTINGS,
    mode: 'auto',
    target: { mode: 'fixed', provider: 'p', model: 'm' },
    materials: { question: true, selection: false, plan: true, diff: true, test: false },
  })

  const off = applySettingsPatch(before, { enabled: false })
  assert.equal(off.enabled, false)
  assert.equal(off.mode, 'auto')
  assert.deepEqual(off.target, before.target)
  assert.deepEqual(off.materials, before.materials)

  const backOn = applySettingsPatch(off, { enabled: true })
  assert.equal(backOn.enabled, true)
  assert.equal(backOn.mode, 'auto')
})

function serviceWith(settings, { onStream } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-advisor-switch-'))
  const calls = []
  const llm = {
    stream(request) {
      calls.push(request)
      if (onStream) return onStream(request)
      return (async function* generate() {
        yield { type: 'text-delta', text: '建议' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const service = createConsultService({
    llm,
    home,
    getSettings: () => settings,
    saveSettings: () => {},
    getSession: () => ({ snapshotEvents: () => [], cwd: null }),
    getSessionSelection: () => ({ provider: 'fake', model: 'fake-model' }),
    log: () => {},
  })
  return { service, calls }
}

test('a consultation against a switched-off advisor is refused, not run', async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    enabled: false,
    mode: 'auto',
    target: { mode: 'fixed', provider: 'fake', model: 'fake-model' },
  }
  const { service, calls } = serviceWith(settings)

  const result = await service.start({
    sessionId: SESSION,
    request: { question: '这个方案有什么问题？', focus: 'general' },
  })

  assert.equal(result.accepted, false)
  assert.equal(result.record.state, 'refused')
  assert.equal(result.record.reason, 'disabled')
  assert.equal(calls.length, 0, 'an off switch must not spend a model call')
})

test('the refusal still lands in history so the reason is visible later', async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    enabled: false,
    mode: 'auto',
    target: { mode: 'fixed', provider: 'fake', model: 'fake-model' },
  }
  const { service } = serviceWith(settings)

  const first = await service.start({
    sessionId: SESSION,
    request: { question: '第一次', focus: 'general' },
  })
  const listed = service.list(SESSION)
  assert.ok(listed.some((record) => record.id === first.record.id))
  const stored = listed.find((record) => record.id === first.record.id)
  assert.equal(stored.reason, 'disabled')
})

test('switching off beats a missing model, so the message names the real cause', async () => {
  // Both conditions hold. The person turned the plugin off first; telling them
  // to go pick a provider would send them to fix something that is not broken.
  const settings = {
    ...DEFAULT_SETTINGS,
    enabled: false,
    target: { mode: 'session', provider: null, model: null },
  }
  const { service } = serviceWith(settings)

  const result = await service.start({
    sessionId: SESSION,
    request: { question: '这个方案有什么问题？', focus: 'general' },
  })

  assert.equal(result.record.reason, 'disabled')
})

test('turning it back on lets the next consultation run normally', async () => {
  const off = {
    ...DEFAULT_SETTINGS,
    enabled: false,
    mode: 'auto',
    target: { mode: 'fixed', provider: 'fake', model: 'fake-model' },
  }
  const on = applySettingsPatch(off, { enabled: true })
  const { service, calls } = serviceWith(on)

  const result = await service.start({
    sessionId: SESSION,
    request: { question: '这个方案有什么问题？', focus: 'general' },
  })

  assert.equal(result.accepted, true)
  await result.done
  assert.equal(calls.length, 1)
})
