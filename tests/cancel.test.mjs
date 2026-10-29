/**
 * Who stopped the wait.
 *
 * A cancel and an exhausted deadline both end with an aborted signal and no
 * result, so the record has to name the initiator rather than infer it
 * afterwards. The case that used to be wrong: the user cancels, and the deadline
 * fires during the cancel grace window — a window this code deliberately keeps
 * open (up to 300 ms) so a stream that was already finishing can finish. Any
 * timer that survives the cancel gets to rename the event.
 *
 * These tests drive the real service end to end, because the defect was in the
 * wiring between `cancel()`, the deadline timer and `classifyOutcome`, not inside
 * any one of them.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createConsultService } from '../lib/consult.js'
import { DEFAULT_SETTINGS } from '../lib/settings.js'

const SESSION = 'session-cancel-test'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A model that sends one delta and then stops only when the signal aborts.
 *
 * `lingerMs` keeps the stream alive past the abort on purpose, so the service
 * spends real time inside its cancel grace window. Without it the stream ends
 * instantly and there is no window for a stray timer to win.
 */
function hangingLlm({ lingerMs = 400 } = {}) {
  const calls = []
  return {
    calls,
    stream(request) {
      calls.push(request)
      return (async function* generate() {
        yield { type: 'text-delta', text: '半句建议' }
        await new Promise((resolve) => {
          const signal = request.signal
          if (!signal) return
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        if (lingerMs > 0) await sleep(lingerMs)
        yield { type: 'finish', reason: { kind: 'aborted' } }
      })()
    },
  }
}

function serviceWith({ deadlineMs, lingerMs }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-advisor-cancel-'))
  const settings = {
    ...DEFAULT_SETTINGS,
    mode: 'auto',
    target: { mode: 'fixed', provider: 'fake', model: 'fake-model' },
    materials: { question: true, selection: false, plan: false, diff: false, test: false },
    advanced: { ...DEFAULT_SETTINGS.advanced, consultDeadlineMs: deadlineMs },
  }
  const llm = hangingLlm({ lingerMs })
  const service = createConsultService({
    llm,
    home,
    getSettings: () => settings,
    saveSettings: () => {},
    getSession: () => ({ snapshotEvents: () => [], cwd: null }),
    getSessionSelection: () => ({ provider: 'fake', model: 'fake-model' }),
    log: () => {},
  })
  return { service, llm }
}

async function start(service) {
  return service.start({ sessionId: SESSION, request: { question: '这个方案有什么问题？', focus: 'general' } })
}

test('a cancel well before the deadline is recorded as a cancel', async () => {
  const { service } = serviceWith({ deadlineMs: 5000 })
  const started = await start(service)
  assert.equal(started.accepted, true)
  await sleep(120)
  assert.equal(service.cancel(SESSION, started.record.id).ok, true)
  const settled = await started.done
  assert.equal(settled.state, 'cancelled')
  assert.equal(settled.reason, 'cancelled-locally')
})

test('a cancel that lands inside the deadline grace window is still a cancel', async () => {
  // Deadline is 400 ms out; the cancel arrives at 150 ms, so the deadline fires
  // while the service is still waiting out its 300 ms cancel grace. Before the
  // fix this record said `timed_out` and blamed a budget the user never hit.
  const { service } = serviceWith({ deadlineMs: 400 })
  const started = await start(service)
  assert.equal(started.accepted, true)
  await sleep(150)
  assert.equal(service.cancel(SESSION, started.record.id).ok, true)
  const settled = await started.done
  assert.equal(settled.state, 'cancelled')
  assert.equal(settled.reason, 'cancelled-locally')
})

test('an expired deadline with no cancel is still recorded as a timeout', async () => {
  const { service } = serviceWith({ deadlineMs: 150 })
  const started = await start(service)
  assert.equal(started.accepted, true)
  const settled = await started.done
  assert.equal(settled.state, 'timed_out')
  assert.equal(settled.reason, 'deadline')
})

test('a cancel that arrives after the deadline already fired keeps the timeout', async () => {
  // Order decides, and the deadline got there first. The user's later cancel
  // must not rewrite what already happened — the request really did run out of
  // budget, and calling it a cancel would hide that.
  const { service } = serviceWith({ deadlineMs: 120 })
  const started = await start(service)
  assert.equal(started.accepted, true)
  await sleep(220)
  const late = service.cancel(SESSION, started.record.id)
  assert.equal(late.ok, true)
  const settled = await started.done
  assert.equal(settled.state, 'timed_out')
  assert.equal(settled.reason, 'deadline')
})
