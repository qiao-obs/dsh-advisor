/**
 * The tool half must honour the same preferences as the composer half.
 *
 * This is a regression suite for a real hole: `settings.json` was read only by
 * the host channel, so a model-initiated `advisor_consult` ignored both the
 * master switch and the "only when I ask" mode. A person who switched the
 * advisor off still had the model spending their money at a second provider.
 *
 * Every check here is local and free: a fake `llm` counts calls, so "the switch
 * stopped it" is measured as zero model calls rather than as a returned string.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdvisor } from '../lib/index.js'
import { execFor, makeFakeLlm } from './helpers.mjs'

const CONFIG = { provider: 'p', model: 'm', outputDir: null }

function advisorWith(settings) {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({
    llm,
    config: CONFIG,
    readSettings: () => settings,
  })
  return { llm, advisor }
}

test('the master switch stops a model-initiated consultation before any provider call', async () => {
  const { llm, advisor } = advisorWith({ enabled: false, mode: 'auto' })
  const value = await advisor.tool.execute({ question: 'Is this rename risky?', focus: 'plan' }, execFor('c-off'))

  assert.equal(llm.state.calls, 0, 'a switched-off advisor must not cost a model call')
  assert.equal(value.outcome, 'refused_no_consent')
  assert.match(value.advice, /switched off/i)
  // The refusal must carry the same keys as every other exit, or a caller has to
  // tell "false" apart from "this path forgot the field".
  for (const key of ['consultationId', 'cancelled', 'timedOut', 'truncated', 'budgetRemaining']) {
    assert.ok(key in value, `refusal is missing ${key}`)
  }
})

test('manual mode refuses a model-initiated call, because a tool call is not a person asking', async () => {
  const { llm, advisor } = advisorWith({ enabled: true, mode: 'manual' })
  const value = await advisor.tool.execute({ question: 'Is this rename risky?', focus: 'plan' }, execFor('c-manual'))

  assert.equal(llm.state.calls, 0)
  assert.equal(value.outcome, 'refused_no_consent')
  assert.match(value.advice, /only when I ask/i)
})

test('confirm mode lets the call through, because the consent seam is exactly that confirmation', async () => {
  const { llm, advisor } = advisorWith({ enabled: true, mode: 'confirm' })
  const value = await advisor.tool.execute({ question: 'Is this rename risky?', focus: 'plan' }, execFor('c-confirm'))

  assert.equal(llm.state.calls, 1, 'confirm mode is a prompt, not a refusal')
  assert.equal(value.outcome, 'advised')
})

test('auto mode lets the call through without asking', async () => {
  const { llm, advisor } = advisorWith({ enabled: true, mode: 'auto' })
  const value = await advisor.tool.execute({ question: 'Is this rename risky?', focus: 'plan' }, execFor('c-auto'))

  assert.equal(llm.state.calls, 1)
  assert.equal(value.outcome, 'advised')
})

test('a per-session grant elevates manual to auto for that session only', async () => {
  const settings = {
    enabled: true,
    mode: 'manual',
    sessionGrants: { 'session-granted': { at: Date.now() } },
  }
  const granted = advisorWith(settings)
  const grantedValue = await granted.advisor.tool.execute(
    { question: 'Is this rename risky?', focus: 'plan' },
    execFor('c-grant', null, { session: { id: 'session-granted' } }),
  )
  assert.equal(granted.llm.state.calls, 1, 'a grant recorded for this session must be honoured')
  assert.equal(grantedValue.outcome, 'advised')

  const other = advisorWith(settings)
  const otherValue = await other.advisor.tool.execute(
    { question: 'Is this rename risky?', focus: 'plan' },
    execFor('c-other', null, { session: { id: 'session-other' } }),
  )
  assert.equal(other.llm.state.calls, 0, 'a grant must not leak into another session')
  assert.equal(otherValue.outcome, 'refused_no_consent')
})

test('the switch beats a missing model, so the reported cause is the real one', async () => {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({ llm, config: { outputDir: null }, readSettings: () => ({ enabled: false }) })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('c-both'))

  assert.equal(llm.state.calls, 0)
  assert.match(value.advice, /switched off/i, 'an off switch is the cause, not the absent model')
})

test('an unreadable settings file does not silently disable the advisor', async () => {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({
    llm,
    config: CONFIG,
    readSettings: () => {
      throw new Error('disk on fire')
    },
  })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('c-broken'))

  assert.equal(llm.state.calls, 1, 'a broken file must not become a silent kill switch')
  assert.equal(value.outcome, 'advised')
})

test('a mount with no home and no reader behaves exactly as before the switch existed', async () => {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({ llm, config: CONFIG })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('c-legacy'))

  assert.equal(llm.state.calls, 1)
  assert.equal(value.outcome, 'advised')
})
