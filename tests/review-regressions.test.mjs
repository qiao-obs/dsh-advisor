import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConsultService } from '../lib/consult.js'
import { openHistory } from '../lib/history.js'
import { normalizeSettings, effectiveMode, resolveConsultTarget } from '../lib/settings.js'
import { createHost } from '../lib/host.js'
import { createAdvisor } from '../lib/index.js'
import { collectMaterials } from '../lib/materials.js'
import { makeFakeLlm, execFor } from './helpers.mjs'

function fixture(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'advisor-review-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const settings = normalizeSettings({
    mode: 'auto', target: { mode: 'fixed', provider: 'p', model: 'm' },
    materials: { question: true, selection: false, plan: false, diff: false, test: false },
    ...options.settings,
  })
  const llm = options.llm ?? makeFakeLlm()
  const session = options.session ?? { cwd: null, snapshotEvents: () => [] }
  const service = createConsultService({ home, llm, getSettings: () => settings,
    getSession: () => session, getSessionSelection: () => null,
    ...options.service,
  })
  return { home, settings, llm, session, service }
}

function controlledLlm() {
  const releases = []
  return {
    releases,
    stream() {
      let release
      const gate = new Promise(r => { release = r })
      releases.push(release)
      return (async function* () {
        await gate
        yield { type: 'text-delta', text: 'Check this finding.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('overlapping consultations preserve all terminal records and annotations', async t => {
  const llm = controlledLlm()
  const { service } = fixture(t, { llm })
  const first = await service.start({ sessionId: 's', request: { question: 'first' } })
  const second = await service.start({ sessionId: 's', request: { question: 'second' } })
  llm.releases[0]()
  await first.done
  service.annotate('s', first.record.id, { verification: 'confirmed', verdictNote: 'Checked.' })
  llm.releases[1]()
  await second.done
  const records = service.list('s')
  assert.equal(records.length, 2)
  assert.ok(records.every(r => r.state === 'returned'))
  assert.equal(service.get('s', first.record.id).verification, 'confirmed')
})

test('cleared records are not resurrected when a pending consultation settles', async t => {
  const llm = controlledLlm()
  const { service } = fixture(t, { llm })
  const first = await service.start({ sessionId: 's', request: { question: 'first' } })
  service.clear('s')
  llm.releases[0]()
  await first.done
  assert.deepEqual(service.list('s'), [])
})

test('session budget survives history rotation, reopening and clearing', async t => {
  const { service, home } = fixture(t, { llm: makeFakeLlm({ text: 'NO_ADVICE' }),
    settings: { advanced: { historyLimit: 5, maxConsultationsPerSession: 6 } } })
  for (let n = 0; n < 6; n++) {
    const run = await service.start({ sessionId: 's', request: { question: String(n) } })
    assert.equal(run.accepted, true)
    await run.done
  }
  assert.equal(service.list('s').length, 5)
  const refused = await service.start({ sessionId: 's', request: { question: 'over' } })
  assert.equal(refused.accepted, false)
  assert.equal(refused.record.reason, 'session-budget-exhausted')
  service.clear('s')
  const reloaded = createConsultService({ home, llm: makeFakeLlm(),
    getSettings: () => normalizeSettings({ target: { mode: 'fixed', provider: 'p', model: 'm' }, advanced: { maxConsultationsPerSession: 6 } }),
    getSession: () => null, getSessionSelection: () => null })
  assert.equal((await reloaded.start({ sessionId: 's', request: { question: 'after clear' } })).accepted, false)
})

test('material warnings and digests survive persistence', t => {
  const { home } = fixture(t)
  const history = openHistory(home, 's')
  history.put({ id: 'x', state: 'returned', origin: 'user', summary: 'finding', adviceDigest: 'sha256:abc',
    materials: { digest: 'sha256:abc', summary: 'plan', truncated: ['plan'], fromEarlierTurn: ['plan'], absent: [{ kind: 'diff', reason: 'unavailable' }] } })
  const saved = openHistory(home, 's').get('x')
  assert.deepEqual(saved.materials.truncated, ['plan'])
  assert.deepEqual(saved.materials.fromEarlierTurn, ['plan'])
  assert.equal(saved.materials.digest, 'sha256:abc')
  assert.equal(saved.adviceDigest, 'sha256:abc')
})

test('confirm mode asks before a preauthorized plan and respects denial', async () => {
  const llm = makeFakeLlm()
  let asks = 0
  const advisor = createAdvisor({ llm, config: { provider: 'p', model: 'm' },
    readSettings: () => normalizeSettings({ mode: 'confirm' }),
    getUserQuestions: () => ({ askTimed: async () => { asks++; return { answers: [{ selected: ['Deny'] }] } } }) })
  const result = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('deny', null, {}))
  assert.equal(asks, 1)
  assert.equal(llm.state.calls, 0)
  assert.equal(result.outcome, 'refused_no_consent')
})

test('auto mode covers a non-default focus without a confirmation service', async () => {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({ llm, config: { provider: 'p', model: 'm' },
    readSettings: () => normalizeSettings({ mode: 'auto' }) })
  const result = await advisor.tool.execute({ question: 'q', focus: 'general' }, execFor('auto'))
  assert.equal(llm.state.calls, 1)
  assert.equal(result.outcome, 'advised')
})

test('expired session grants cannot authorize a cached settings object', () => {
  assert.equal(effectiveMode({ mode: 'manual', sessionGrants: { s: { at: Date.now() - 86400001 } } }, 's'), 'manual')
})

test('changed preview materials are refused before calling the provider', async t => {
  let plan = 'original plan'
  const session = { snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: plan }] } } }] }
  const { service, settings, llm } = fixture(t, { session, settings: { materials: { plan: true } } })
  const request = { question: 'review', focus: 'plan' }
  const preview = await collectMaterials({ settings, session, sessionId: 's', request })
  plan = 'different plan, never approved'
  const run = await service.start({ sessionId: 's', request: { ...request, expectedDigest: preview.digest } })
  if (run.done) await run.done
  assert.equal(run.accepted, false)
  assert.equal(run.record.reason, 'materials-changed')
  assert.equal(llm.state.calls, 0)
})

test('cancelling during preparation never calls the provider', async t => {
  let release
  const ready = new Promise(r => { release = r })
  const session = { snapshotEvents: () => [{ type: 'workspace/changes', seq: 1 }] }
  const { service, llm } = fixture(t, { session, settings: { materials: { diff: true } }, service: { workspaceChanges: {
    summary: () => ({ total: 1, files: [{ path: 'a' }] }), diff: () => ready,
  } } })
  const pending = service.start({ sessionId: 's', request: { question: 'q' } })
  const record = service.list('s')[0]
  assert.equal(record.state, 'preparing')
  service.cancel('s', record.id)
  release(null)
  const run = await pending
  if (run.done) await run.done
  assert.equal(llm.state.calls, 0)
  assert.equal(service.get('s', record.id).state, 'cancelled')
})


test('an incomplete fixed model never falls back to a session provider', () => {
  const settings = normalizeSettings({ target: { mode: 'fixed', provider: 'new-provider', model: null } })
  assert.equal(settings.target.mode, 'fixed')
  assert.equal(resolveConsultTarget(settings, { provider: 'other', model: 'other' }).source, 'missing')
})

test('a stalled preparation times out without spending a model call', async t => {
  const { service, llm } = fixture(t, {
    session: { snapshotEvents: () => [{ type: 'workspace/changes', seq: 1 }] },
    settings: { materials: { diff: true } },
    service: { prepareTimeoutMs: 10, workspaceChanges: {
      summary: () => ({ total: 1, files: [{ path: 'a' }] }), diff: () => new Promise(() => {}),
    } },
  })
  const run = await service.start({ sessionId: 's', request: { question: 'q' } })
  assert.equal(run.accepted, false)
  assert.equal(run.record.state, 'timed_out')
  assert.equal(run.record.reason, 'prepare-timeout')
  assert.equal(service.inFlightCount(), 0)
  assert.equal(llm.state.calls, 0)
})

test('disabling while preparing takes effect before contacting the model', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { service, llm, settings } = fixture(t, {
    session: { snapshotEvents: () => [{ type: 'workspace/changes', seq: 1 }] },
    settings: { materials: { diff: true } },
    service: { workspaceChanges: {
      summary: () => ({ total: 1, files: [{ path: 'a' }] }), diff: () => gate,
    } },
  })
  const pending = service.start({ sessionId: 's', request: { question: 'q' } })
  settings.enabled = false
  release(null)
  const run = await pending
  assert.equal(run.accepted, false)
  assert.equal(run.record.reason, 'disabled')
  assert.equal(llm.state.calls, 0)
})

test('a model change after preview is refused', async t => {
  const { service, llm } = fixture(t)
  const run = await service.start({ sessionId: 's', request: { question: 'q', expectedTarget: { provider: 'old', model: 'old' } } })
  assert.equal(run.accepted, false)
  assert.equal(run.record.reason, 'target-changed')
  assert.equal(llm.state.calls, 0)
})

test('an adapter throwing on abort still produces a cancelled record', async t => {
  const llm = { stream({ signal }) { return (async function* () {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true }))
  })() } }
  const { service } = fixture(t, { llm })
  const run = await service.start({ sessionId: 's', request: { question: 'q' } })
  service.cancel('s', run.record.id)
  const record = await run.done
  assert.equal(record.state, 'cancelled')
  assert.equal(record.reason, 'cancelled-locally')
})

test('NO_ADVICE does not become an opinion awaiting verification', async t => {
  const { service } = fixture(t, { llm: makeFakeLlm({ text: 'NO_ADVICE' }) })
  const run = await service.start({ sessionId: 's', request: { question: 'q' } })
  const record = await run.done
  assert.equal(record.state, 'no_advice')
  assert.equal(record.advice, '')
})


test('model-initiated calls honor the live fixed model and output cap', async () => {
  const llm = makeFakeLlm()
  let settings = normalizeSettings({ mode: 'auto', target: { mode: 'fixed', provider: 'chosen', model: 'chosen-model' }, advanced: { maxAdviceTokens: 512 } })
  const advisor = createAdvisor({ llm, config: { provider: 'old', model: 'old-model' }, readSettings: () => settings })
  await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('first-target'))
  assert.equal(llm.state.requests[0].provider, 'chosen')
  assert.equal(llm.state.requests[0].model, 'chosen-model')
  assert.equal(llm.state.requests[0].maxTokens, 512)
  settings = normalizeSettings({ ...settings, target: { mode: 'fixed', provider: 'new', model: 'new-model' } })
  await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('second-target'))
  assert.equal(llm.state.requests[1].provider, 'new')
})

test('turning off while confirmation is open prevents the eventual call', async () => {
  const llm = makeFakeLlm()
  const settings = normalizeSettings({ mode: 'confirm' })
  const advisor = createAdvisor({ llm, config: { provider: 'p', model: 'm' }, readSettings: () => settings,
    getUserQuestions: () => ({ askTimed: async () => {
      settings.enabled = false
      return { answers: [{ selected: ['Allow once'] }] }
    } }),
  })
  const result = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('disabled-after-ask', null, {}))
  assert.equal(llm.state.calls, 0)
  assert.equal(result.outcome, 'refused_no_consent')
})


test('manual and model entry points share the persistent session ceiling', async t => {
  const { home, settings, service } = fixture(t, { settings: { advanced: { maxConsultationsPerSession: 1 } } })
  const toolLlm = makeFakeLlm()
  const advisor = createAdvisor({ home, llm: toolLlm, config: { provider: 'p', model: 'm' }, readSettings: () => settings })
  const answer = await advisor.tool.execute({ question: 'q', focus: 'general' }, execFor('shared-budget', null, { session: { id: 's' } }))
  assert.equal(answer.outcome, 'advised')
  const refused = await service.start({ sessionId: 's', request: { question: 'second' } })
  assert.equal(refused.accepted, false)
  assert.equal(refused.record.reason, 'session-budget-exhausted')
  const other = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('shared-budget2', null, { session: { id: 's' } }))
  assert.equal(other.outcome, 'budget_exhausted')
  assert.equal(toolLlm.state.calls, 1)
})

test('a denied model consultation refunds its session reservation', async t => {
  const { home, settings } = fixture(t, { settings: { mode: 'confirm', advanced: { maxConsultationsPerSession: 1 } } })
  const llm = makeFakeLlm()
  const advisor = createAdvisor({ home, llm, config: { provider: 'p', model: 'm' }, readSettings: () => settings,
    getUserQuestions: () => ({ askTimed: async () => ({ answers: [{ selected: ['Deny'] }] }) }),
  })
  await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('refund', null, { session: { id: 's' } }))
  assert.equal(openHistory(home, 's').issuedCount, 0)
  assert.equal(llm.state.calls, 0)
})

function hostFixture(t, options = {}) {
  const { home } = fixture(t)
  const llm = options.llm ?? makeFakeLlm()
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, ...options.services }
  const host = createHost({ home, ctx: { get: name => services[name] }, getSession: () => ({ snapshotEvents: () => [] }), ...options.host })
  return { host, llm }
}

test('host requires a preview and accepts an unchanged preview', async t => {
  const { host, llm } = hostFixture(t)
  await assert.rejects(host.handlers['consult.start']({ sessionId: 's', request: { question: 'q' } }), { code: 'preview-required' })
  assert.equal(llm.state.calls, 0)
  const preview = await host.handlers['materials.preview']({ sessionId: 's', request: { question: 'q' } })
  const run = await host.handlers['consult.start']({ sessionId: 's', request: { question: 'q', expectedDigest: preview.digest, expectedTarget: preview.target } })
  assert.equal(run.accepted, true)
  // No external provider is used. Drain the fake stream before removing its home.
  while (host.consult.inFlightCount()) await new Promise(r => setImmediate(r))
  assert.equal(llm.state.calls, 1)
})

test('a stalled preview is bounded without calling a provider', async t => {
  const { host, llm } = hostFixture(t, { host: { prepareTimeoutMs: 10,
    getSession: () => ({ snapshotEvents: () => [{ type: 'workspace/changes', seq: 1 }] }),
    workspaceChanges: { summary: () => ({ total: 1, files: [{ path: 'a' }] }), diff: () => new Promise(() => {}) },
  } })
  host.persist(normalizeSettings({ materials: { diff: true } }))
  const preview = await host.handlers['materials.preview']({ sessionId: 's', request: { question: 'q' } })
  assert.equal(preview.ok, false)
  assert.equal(llm.state.calls, 0)
})

test('delivery waits for acknowledgement and reports an async rejection', async t => {
  const { host } = hostFixture(t, { services: { agents: { get: () => ({ followup: async () => { throw new Error('delivery rejected') } }) } } })
  const run = await host.consult.start({ sessionId: 's', request: { question: 'q' } })
  const record = await run.done
  const delivery = await host.handlers['consult.deliver']({ sessionId: 's', consultationId: record.id })
  assert.equal(delivery.ok, false)
  assert.match(delivery.message, /delivery rejected/)
  assert.equal(host.consult.get('s', record.id).deliveredToModel, false)
})

test('connection check times out even if the adapter ignores abort', async t => {
  const { host } = hostFixture(t, { llm: { stream: () => (async function* () { await new Promise(() => {}) })() }, host: { connectionTimeoutMs: 10 } })
  // Keep the event loop alive: production has a web server; the timer is unref'ed.
  const keeper = setInterval(() => {}, 100)
  try {
    const result = await host.handlers['check.connection']({ sessionId: 's' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'timeout')
  } finally { clearInterval(keeper) }
})
