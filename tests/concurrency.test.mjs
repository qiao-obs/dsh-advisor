// Concurrent consultations are capped per session.
//
// Each in-flight consultation is a paid request. The screen can only show so
// many, and a client that resends on a stuck button would otherwise stack up
// requests that look identical but each cost money. The refusal is recorded like
// every other refusal so the history explains what happened.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConsultService } from '../lib/consult.js'
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/settings.js'
import { STATES } from '../lib/history.js'

const CAP = 3

function settings(over = {}) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    mode: 'auto',
    target: { mode: 'fixed', provider: 'p', model: 'm' },
    materials: { question: true, selection: false, plan: false, diff: false, test: false },
    ...over,
  })
}

/**
 * An llm whose streams never settle on their own, so consultations stay in
 * flight until the test releases them. `stream` must return an async iterable —
 * the real service is consumed with `for await`, and a bare Promise would throw
 * instead of hanging, which would make every one of these tests pass for the
 * wrong reason.
 */
function hangingLlm() {
  const state = { calls: 0, release: [] }
  return {
    state,
    stream() {
      state.calls += 1
      let open
      const gate = new Promise((resolve) => {
        open = resolve
      })
      state.release.push(open)
      return (async function* chunks() {
        await gate
        yield { type: 'text-delta', text: 'NO_ADVICE' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function makeService({ home, llm, current = settings() }) {
  let live = current
  return createConsultService({
    llm,
    home,
    getSettings: () => live,
    saveSettings: (next) => {
      live = next
      return next
    },
    getSession: () => ({ cwd: null }),
    getSessionSelection: () => ({ provider: 'p', model: 'm' }),
    workspaceChanges: null,
    log: () => {},
    language: 'en',
  })
}

test('a fourth concurrent consultation in one session is refused before any request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-advisor-inflight-'))
  try {
    const llm = hangingLlm()
    const service = makeService({ home, llm })

    for (let i = 0; i < CAP; i += 1) {
      const started = await service.start({ sessionId: 's1', request: { question: `q${i}` } })
      assert.equal(started.accepted, true, `consultation ${i} should be accepted`)
    }
    assert.equal(llm.state.calls, CAP)

    const extra = await service.start({ sessionId: 's1', request: { question: 'one too many' } })
    assert.equal(extra.accepted, false)
    assert.equal(extra.record.state, STATES.refused)
    assert.equal(extra.record.reason, 'too-many-in-flight')
    // The point of the cap: the refused attempt never reached the provider.
    assert.equal(llm.state.calls, CAP, 'the refused attempt still called the provider')
    // And it is in the history, so the refusal is explainable later.
    assert.ok(service.list('s1').some((entry) => entry.reason === 'too-many-in-flight'))

    service.abortAll()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the cap is per session, not global', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-advisor-inflight-'))
  try {
    const llm = hangingLlm()
    const service = makeService({ home, llm })

    for (let i = 0; i < CAP; i += 1) {
      await service.start({ sessionId: 's1', request: { question: `q${i}` } })
    }
    const other = await service.start({ sessionId: 's2', request: { question: 'elsewhere' } })
    assert.equal(other.accepted, true, 'a busy session must not block a different one')
    assert.equal(llm.state.calls, CAP + 1)

    service.abortAll()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('settling a consultation frees its slot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-advisor-inflight-'))
  try {
    const llm = hangingLlm()
    const service = makeService({ home, llm })

    for (let i = 0; i < CAP; i += 1) {
      await service.start({ sessionId: 's1', request: { question: `q${i}` } })
    }
    assert.equal(service.inFlightCount(), CAP)

    llm.state.release.shift()()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(service.inFlightCount(), CAP - 1)

    const again = await service.start({ sessionId: 's1', request: { question: 'after one finished' } })
    assert.equal(again.accepted, true)

    service.abortAll()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
