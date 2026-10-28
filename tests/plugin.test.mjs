/**
 * The contract the host depends on: what the plugin registers, when it talks to
 * a provider, and what it leaves behind.
 *
 * Every check here is local. A fake `llm` counts calls; a fake `tools` records
 * registrations. If any of these needed a real provider to pass, the plugin
 * would be untestable and therefore unmaintainable.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply, createAdvisor, ADVISOR_TOOL_NAME } from '../lib/index.js'
import { ADVICE, execFor, makeFakeCtx, makeFakeLlm, makeFakeTools, sleep, timerCount } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, '..', 'lib', 'index.js')

test('registers exactly one tool, with the parameters the model needs', () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools })

  apply(ctx, { provider: 'p', model: 'm', outputDir: null })

  assert.deepEqual(tools.list(), [ADVISOR_TOOL_NAME])
  const schema = tools.get(ADVISOR_TOOL_NAME).parameters
  assert.deepEqual(schema.required, ['question'])
  assert.equal(schema.properties.question.type, 'string')
  // A focus the run cannot reach must not be advertised: offering it is a trap,
  // not a consent check.
  assert.deepEqual(schema.properties.focus.enum, ['plan'])
})

test('idle plugin never contacts a provider', async () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools })

  apply(ctx, { provider: 'p', model: 'm', outputDir: null })
  await sleep(300)

  assert.equal(llm.state.calls, 0, 'mounting is not working')
  assert.equal(process.exitCode, undefined, 'the plugin must not end the process')
})

test('one tool call produces exactly one model call', async () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools })

  apply(ctx, { provider: 'p', model: 'm', outputDir: null })
  const value = await tools
    .get(ADVISOR_TOOL_NAME)
    .execute({ question: 'Is this rename risky?', focus: 'plan' }, execFor('call-1'))

  assert.equal(llm.state.calls, 1)
  assert.equal(value.outcome, 'advised')
  assert.equal(value.advice, ADVICE)
  assert.equal(value.cancelled, false)
  assert.equal(value.timedOut, false)
})

test('the request carries no tools and no retry affordance', async () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools })

  apply(ctx, { provider: 'p', model: 'm', maxAdviceTokens: 321, outputDir: null })
  await tools.get(ADVISOR_TOOL_NAME).execute({ question: 'q', focus: 'plan' }, execFor('call-2'))

  const request = llm.state.requests[0]
  assert.equal(request.provider, 'p')
  assert.equal(request.model, 'm')
  assert.equal(request.maxTokens, 321)
  assert.equal(request.tools, undefined, 'the advisor must not hand the second model tools')
  assert.equal(request.messages.length, 1)
})

test('dispose removes the tool and ends a consultation that is still waiting', async () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools })
  apply(ctx, { provider: 'p', model: 'm', outputDir: null })

  const timersBefore = timerCount()
  const controller = new AbortController()
  llm.state.mode = 'hang'
  const inFlight = tools
    .get(ADVISOR_TOOL_NAME)
    .execute({ question: 'dispose while I wait', focus: 'plan' }, execFor('call-3', controller.signal))

  await sleep(60)
  ctx._dispose()
  const value = await inFlight
  await sleep(50)

  assert.deepEqual(tools.list(), [], 'the tool must be gone')
  assert.equal(ctx._disposers.length, 0, 'no disposer may survive')
  assert.equal(value.cancelled, true, 'the unload signal is the only thing that can end this call')
  assert.ok(timerCount() <= timersBefore, 'a leaked timer keeps a headless run alive')
})

test('the budget ceiling is enforced before the request is built', async () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools })
  apply(ctx, { provider: 'p', model: 'm', maxConsultationsPerRun: 2, outputDir: null })

  const tool = tools.get(ADVISOR_TOOL_NAME)
  const outcomes = []
  for (let index = 0; index < 5; index += 1) {
    const value = await tool.execute({ question: `q${index}`, focus: 'plan' }, execFor(`call-b${index}`))
    outcomes.push(value.outcome)
  }

  assert.equal(llm.state.calls, 2, 'a refusal past the ceiling must cost nothing')
  assert.equal(outcomes.filter((o) => o === 'advised').length, 2)
  assert.equal(outcomes.filter((o) => o === 'budget_exhausted').length, 3)
})

test('an over-budget result still satisfies the declared output schema', async () => {
  const advisor = createAdvisor({
    llm: makeFakeLlm(),
    config: { provider: 'p', model: 'm', maxConsultationsPerRun: 0, outputDir: null },
  })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-4'))

  assert.equal(value.outcome, 'budget_exhausted')
  // The declared output says `consultationId` is a string and the host validates
  // it. Returning null here made every over-budget call look malformed, and the
  // caller retried it forever.
  assert.equal(typeof value.consultationId, 'string')
  assert.notEqual(value.consultationId, '')
})

test('every exit path reports the same result keys', async () => {
  // A caller reads `.truncated` on the value it got back. If one path omits the
  // key, `undefined` and `false` become two different things to reason about,
  // and the caller has to know which exit it came from to read the same field.
  const keysOf = (value) => Object.keys(value).sort()

  const unconfigured = await createAdvisor({
    llm: makeFakeLlm(),
    config: { outputDir: null },
  }).tool.execute({ question: 'q', focus: 'plan' }, execFor('call-16'))

  const overBudget = await createAdvisor({
    llm: makeFakeLlm(),
    config: { provider: 'p', model: 'm', maxConsultationsPerRun: 0, outputDir: null },
  }).tool.execute({ question: 'q', focus: 'plan' }, execFor('call-17'))

  const answered = await createAdvisor({
    llm: makeFakeLlm(),
    config: { provider: 'p', model: 'm', outputDir: null },
  }).tool.execute({ question: 'q', focus: 'plan' }, execFor('call-18'))

  assert.deepEqual(keysOf(unconfigured), keysOf(answered))
  assert.deepEqual(keysOf(overBudget), keysOf(answered))
  assert.equal(unconfigured.truncated, false)
  assert.equal(overBudget.truncated, false)
})

test('a cancel is reported as a cancel, never as a timeout', async () => {
  const llm = makeFakeLlm({ mode: 'hang' })
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools })
  apply(ctx, { provider: 'p', model: 'm', outputDir: null })

  const controller = new AbortController()
  const pending = tools
    .get(ADVISOR_TOOL_NAME)
    .execute({ question: 'cancel me', focus: 'plan' }, execFor('call-5', controller.signal))
  await sleep(60)
  controller.abort()
  const value = await pending

  assert.equal(value.cancelled, true)
  assert.equal(value.timedOut, false)
})

test('a consultation deadline is reported as a timeout, not as a cancel', async () => {
  const llm = makeFakeLlm({ mode: 'hang' })
  const advisor = createAdvisor({
    llm,
    config: {
      provider: 'p',
      model: 'm',
      consultDeadlineMs: 80,
      cancelGraceMs: 50,
      outputDir: null,
    },
  })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-6'))

  assert.equal(value.timedOut, true)
  assert.equal(value.cancelled, false)
})

test('an unconfigured mount says so instead of silently failing every call', async () => {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({ llm, config: { outputDir: null } })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-7'))

  assert.equal(value.outcome, 'failed')
  assert.match(value.advice, /not configured/u)
  assert.equal(llm.state.calls, 0, 'a misconfigured mount must not have spent anything')
})

test('the entry point never ends the host process', () => {
  const source = readFileSync(ENTRY, 'utf8')
  for (const forbidden of ['process.exit', 'process.abort']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in lib/index.js`)
  }
})

test('the session default model is used when no provider is configured', async () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({
    llm,
    tools,
    services: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'session-provider', model: 'session-model' }),
      },
    },
  })

  apply(ctx, { outputDir: null })
  await tools.get(ADVISOR_TOOL_NAME).execute({ question: 'q', focus: 'plan' }, execFor('call-8'))

  // The whole point: installing this plugin cannot send a session's work to a
  // provider the user never chose.
  assert.equal(llm.state.requests[0].provider, 'session-provider')
  assert.equal(llm.state.requests[0].model, 'session-model')
})

test('a focus outside the authorized set is refused without spending a call', async () => {
  const llm = makeFakeLlm()
  const tools = makeFakeTools()
  const ctx = makeFakeCtx({ llm, tools, services: {} })
  apply(ctx, { provider: 'p', model: 'm', authorizedScopes: ['plan'], outputDir: null })

  // `general` is not in the schema, but a caller can still send it.
  const value = await tools
    .get(ADVISOR_TOOL_NAME)
    .execute({ question: 'q', focus: 'general' }, execFor('call-9'))

  assert.equal(value.outcome, 'refused_no_consent')
  assert.equal(llm.state.calls, 0, 'no consent means no request')
})

test('advice can be withheld while still paying for the call', async () => {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({
    llm,
    config: { provider: 'p', model: 'm', injectAdvice: false, outputDir: null },
  })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-10'))

  assert.equal(llm.state.calls, 1)
  assert.equal(value.advice, '')
  assert.equal(value.adviceWithheld, true)
})

test('an answer cut off by the output budget still reaches the caller', async () => {
  // A real consultation on 2026-10-28 hit the old 400-token default: 1776
  // characters of usable guidance were thrown away and replaced by the sentence
  // "the advisor stopped with max-tokens". The caller had paid for it and never
  // saw a word. Being cut off is a property of the text, not proof there is none.
  const cutOff = 'Start by checking the caller. Then handle the empty object. The third step is'
  const llm = makeFakeLlm({ text: cutOff, finishKind: 'max-tokens' })
  const advisor = createAdvisor({
    llm,
    config: { provider: 'p', model: 'm', outputDir: null },
  })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-11'))

  assert.equal(value.outcome, 'advised', 'a cut-off answer is still an answer')
  assert.equal(value.advice, cutOff, 'the text must survive the cut-off verbatim')
  assert.equal(value.truncated, true, 'and the caller must be told it was cut off')
})

test('a cut-off answer says so where the caller reads it', async () => {
  const cutOff = 'Check the caller first. Then confirm the empty object'
  const llm = makeFakeLlm({ text: cutOff, finishKind: 'max-tokens' })
  const advisor = createAdvisor({ llm, config: { provider: 'p', model: 'm', outputDir: null } })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-12'))
  const rendered = advisor.tool.output.render({}, value)
    .map((part) => part.text)
    .join('')

  assert.ok(rendered.includes(cutOff), 'the advice itself is shown')
  assert.match(rendered, /output budget/u, 'and the note explains why it stops mid-thought')
})

test('a complete answer is not described as cut off', async () => {
  const llm = makeFakeLlm()
  const advisor = createAdvisor({ llm, config: { provider: 'p', model: 'm', outputDir: null } })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-13'))
  const rendered = advisor.tool.output.render({}, value)
    .map((part) => part.text)
    .join('')

  assert.equal(value.truncated, false)
  assert.doesNotMatch(rendered, /output budget/u)
})

test('other non-stop endings are still not advice', async () => {
  // Only the output budget deserves a second look. An `error` finish means the
  // stream broke, and calling that an opinion would be inventing one.
  const llm = makeFakeLlm({ text: 'partial', finishKind: 'error' })
  const advisor = createAdvisor({ llm, config: { provider: 'p', model: 'm', outputDir: null } })
  const value = await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-14'))

  assert.equal(value.outcome, 'failed')
  assert.equal(value.truncated, false)
  assert.match(value.advice, /error/u)
})

test('the default output budget does not fight the character ceiling', async () => {
  // ADVICE_PROTOCOL.maxChars accepts 4000 characters of advice. A default token
  // budget that cannot produce that many turns the transport ceiling into the
  // real one, silently, so the two must not disagree.
  const llm = makeFakeLlm()
  const advisor = createAdvisor({ llm, config: { provider: 'p', model: 'm', outputDir: null } })
  await advisor.tool.execute({ question: 'q', focus: 'plan' }, execFor('call-15'))

  assert.ok(
    llm.state.requests[0].maxTokens >= 1000,
    `the default budget (${llm.state.requests[0].maxTokens}) is below the ~1000 tokens 4000 characters needs`,
  )
  assert.equal(advisor.config.maxAdviceTokens, 1000)
})
