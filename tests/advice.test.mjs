/**
 * The advice protocol: what counts as an answer, what counts as "no answer",
 * and what is merely long.
 *
 * The cases here are the ones that were actually wrong at some point. In
 * particular, `fixtures/advice-regressions.json` holds three real responses that
 * an earlier version of this parser rejected outright because it counted
 * sentences. They are long, they are structured as prose with numbered points,
 * and they are exactly the kind of answer a working session needs. A parser that
 * fails them is a parser that throws away good advice over a comma.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ADVICE_PROTOCOL,
  buildAdvisorSystemPrompt,
  classifyUsage,
  collectStream,
  parseAdvice,
} from '../lib/advisor.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures', 'advice-regressions.json'), 'utf8'))

test('empty input is empty, not advice about nothing', () => {
  for (const value of ['', '   ', '\n\n', null, undefined, 42]) {
    const parsed = parseAdvice(value)
    assert.equal(parsed.kind, 'empty')
    assert.equal(parsed.text, '')
  }
})

test('NO_ADVICE is a completion, not a failure', () => {
  const parsed = parseAdvice('NO_ADVICE')
  assert.equal(parsed.kind, 'no-advice')
  assert.equal(parsed.text, 'NO_ADVICE')
  // Whitespace around the token is still the token.
  assert.equal(parseAdvice('  NO_ADVICE\n').kind, 'no-advice')
})

test('ordinary prose is advice', () => {
  const parsed = parseAdvice('Check the caller first.')
  assert.equal(parsed.kind, 'advice')
  assert.equal(parsed.text, 'Check the caller first.')
})

test('sentence count is reported but never rejects', () => {
  // Eight sentences, one usable opinion. The old rule refused this.
  const long = 'One. Two. Three. Four. Five. Six. Seven. Eight.'
  const parsed = parseAdvice(long)
  assert.equal(parsed.kind, 'advice')
  assert.equal(parsed.sentences, 8)
  assert.ok(parsed.sentences > ADVICE_PROTOCOL.maxSentences)
})

test('every response that once failed the parser now parses as advice', () => {
  assert.ok(FIXTURES.responses.length >= 3, 'the regression corpus must keep its real responses')
  for (const [index, response] of FIXTURES.responses.entries()) {
    const parsed = parseAdvice(response.text)
    assert.equal(parsed.kind, 'advice', `response #${index + 1} must be usable advice`)
    assert.equal(parsed.chars, response.text.trim().length)
    assert.equal(parsed.text, response.text.trim(), 'the text must survive verbatim')
  }
})

test('only an over-long response is refused structurally', () => {
  const over = 'x'.repeat(ADVICE_PROTOCOL.maxChars + 1)
  const parsed = parseAdvice(over)
  assert.equal(parsed.kind, 'too-long')
  assert.equal(parsed.reason, 'over-character-ceiling')
  // Refused as advice, but still readable in the record.
  assert.equal(parsed.text.length, over.length)

  const atCeiling = 'y'.repeat(ADVICE_PROTOCOL.maxChars)
  assert.equal(parseAdvice(atCeiling).kind, 'advice')
})

test('the prompt states the shape it expects, including the opt-out token', () => {
  const prompt = buildAdvisorSystemPrompt('plan')
  assert.match(prompt, /NO_ADVICE/u)
  assert.match(prompt, /plan/u)
  // Brevity is a request to the model, not a rule enforced against it.
  assert.match(prompt, /brief/iu)
})

test('usage with no chunk is unknown, not zero', () => {
  const classified = classifyUsage({ chunkSeen: false, usage: null })
  assert.equal(classified.usageRaw, null)
  assert.equal(classified.usageOrigin, 'unknown')
  assert.equal(classified.usageCompleteness, 'missing')
})

test('a usage chunk that carries only zeros is still a measurement', () => {
  const usage = { inputTokens: 0, outputTokens: 0 }
  const classified = classifyUsage({ chunkSeen: true, usage })
  // The numbers are zero and they arrived: that is different from absent.
  assert.deepEqual(classified.usageRaw, usage)
  assert.equal(classified.usageCompleteness, 'complete')
  // But their provenance is still unknown: the kernel carries no proof.
  assert.equal(classified.usageOrigin, 'unknown')
})

test('a readback missing one direction is partial, not complete', () => {
  const classified = classifyUsage({ chunkSeen: true, usage: { inputTokens: 12 } })
  assert.equal(classified.usageCompleteness, 'partial')
})

test('an explicit transport claim is honoured', () => {
  const usage = { inputTokens: 1, outputTokens: 2 }
  const classified = classifyUsage({ chunkSeen: true, usage, originClaim: 'provider-reported' })
  assert.equal(classified.usageOrigin, 'provider-reported')
  assert.equal(classified.usageOriginEvidence, 'transport-declared')
})

test('an unrecognised claim is not trusted', () => {
  const usage = { inputTokens: 1, outputTokens: 2 }
  const classified = classifyUsage({ chunkSeen: true, usage, originClaim: 'trust-me' })
  assert.equal(classified.usageOrigin, 'unknown')
})

test('collectStream keeps text, usage, and the finish reason apart', async () => {
  const chunks = [
    { type: 'text-delta', text: 'half ' },
    { type: 'text-delta', text: 'an answer' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const collected = await collectStream((async function* () { yield* chunks })())

  assert.equal(collected.text, 'half an answer')
  assert.deepEqual(collected.usage, { inputTokens: 3, outputTokens: 4 })
  assert.equal(collected.usageChunkSeen, true)
  assert.deepEqual(collected.finish, { kind: 'stop' })
})

test('a usage chunk carrying null still counts as a chunk having arrived', async () => {
  // This is the case the old code got wrong: it tested the VALUE, so a chunk
  // that explicitly said "null" was recorded as "nothing arrived".
  const collected = await collectStream(
    (async function* () {
      yield { type: 'text-delta', text: 'x' }
      yield { type: 'usage', usage: null }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )
  assert.equal(collected.usageChunkSeen, true)
  assert.equal(collected.usage, null)
})

test('a stream that ends without a finish reports no finish', async () => {
  const collected = await collectStream(
    (async function* () {
      yield { type: 'text-delta', text: 'partial' }
    })(),
  )
  assert.equal(collected.finish, null)
  assert.equal(collected.text, 'partial')
})
