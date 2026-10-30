/**
 * The terminal state machine, tested as a pure function.
 *
 * Two pairs are easy to get wrong, and both were raised as defects in a real
 * review: "a cut-off answer versus a returned one", and "cancelled versus
 * timed out". Neither was actually conflated in the code — but nothing proved
 * that, because this function had no tests. These assertions are that proof.
 *
 * They are written against the *observation*, not the prose: each case feeds the
 * exact shape the wire produces and asserts the state the user ends up seeing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { STATES } from '../lib/history.js'
import { classifyOutcome, terminalReason } from '../lib/consult.js'

function streamed(result) {
  return { kind: 'stream', result }
}

const STOPPED = { finish: { kind: 'stop' }, text: '这是一个可以使用的建议。' }

test('a natural stop with usable text is a returned answer', () => {
  assert.equal(classifyOutcome({ race: streamed(STOPPED), deadlineFired: false, aborted: false }), STATES.returned)
})

test('an answer cut off by the output budget is truncated, not returned', () => {
  const cut = { finish: { kind: 'max-tokens' }, text: '这是一个被截断的建议，结尾' }
  assert.equal(classifyOutcome({ race: streamed(cut), deadlineFired: false, aborted: false }), STATES.truncated)
})

test('an answer over the character ceiling is truncated even though the model stopped cleanly', () => {
  const long = { finish: { kind: 'stop' }, text: '很长的建议。'.repeat(900) }
  assert.equal(classifyOutcome({ race: streamed(long), deadlineFired: false, aborted: false }), STATES.truncated)
})

// Regression: a discussion review ends with a fenced advisor-review scorecard.
// Real models routinely kept writing prose after the card and hit the output
// budget, or overshot the character ceiling on a clean stop — either way the
// finished card was discarded as `truncated` and the caller never saw a score.
// A *complete* card is a delivered opinion however the stream ended.
const REVIEW_CARD = '```advisor-review\n' + JSON.stringify({
  verdict: 'proceed',
  summary: 'evidence checks out',
  nextPrompt: 'none needed',
  scores: [
    { dimension: 'correctness', score: 4, reason: 'tests pass' },
    { dimension: 'coverage', score: 3, reason: 'one path untested' },
    { dimension: 'evidence', score: 5, reason: 'raw output supplied' },
  ],
}) + '\n```'

test('a budget-cut answer that already carries a full review card is returned, not truncated', () => {
  const cut = { finish: { kind: 'max-tokens' }, text: '分析如下。\n' + REVIEW_CARD + '\n还有一段被预算截断的散文' }
  assert.equal(classifyOutcome({ race: streamed(cut), deadlineFired: false, aborted: false }), STATES.returned)
})

test('a clean stop over the character ceiling still returns a full review card', () => {
  const long = { finish: { kind: 'stop' }, text: '很长的分析。'.repeat(900) + '\n' + REVIEW_CARD }
  assert.equal(classifyOutcome({ race: streamed(long), deadlineFired: false, aborted: false }), STATES.returned)
})

test('a half-written review card (no closing fence) is still truncated', () => {
  const half = { finish: { kind: 'max-tokens' }, text: '分析如下。\n```advisor-review\n{"verdict":"proceed","summa' }
  assert.equal(classifyOutcome({ race: streamed(half), deadlineFired: false, aborted: false }), STATES.truncated)
})

test('an empty answer is a failure, not an empty review', () => {
  const empty = { finish: { kind: 'stop' }, text: '   ' }
  assert.equal(classifyOutcome({ race: streamed(empty), deadlineFired: false, aborted: false }), STATES.failed)
})

test('NO_ADVICE is a real answer, not a failure', () => {
  const silent = { finish: { kind: 'stop' }, text: 'NO_ADVICE' }
  assert.equal(classifyOutcome({ race: streamed(silent), deadlineFired: false, aborted: false }), STATES.no_advice)
})

test('a user cancel and a deadline expiry land in different states', () => {
  const cancelled = { race: { kind: 'aborted' }, deadlineFired: false, aborted: true }
  const timedOut = { race: { kind: 'aborted' }, deadlineFired: true, aborted: true }
  assert.equal(classifyOutcome(cancelled), STATES.cancelled)
  assert.equal(classifyOutcome(timedOut), STATES.timed_out)
})

test('the deadline flag is what separates them, not the elapsed time', () => {
  // Same wire shape, opposite flag: the initiator decides, and only the
  // initiator knows. Nothing here reads a clock.
  assert.equal(classifyOutcome({ race: { kind: 'aborted' }, deadlineFired: false, aborted: true }), STATES.cancelled)
  assert.equal(classifyOutcome({ race: { kind: 'aborted' }, deadlineFired: true, aborted: true }), STATES.timed_out)
})

test('a stream that ends without a finish is a failure, not a returned answer', () => {
  assert.equal(classifyOutcome({ race: streamed({ text: '有字但没有 finish' }), deadlineFired: false, aborted: false }), STATES.failed)
})

test('a transport error and an aborted stream are both failures', () => {
  for (const kind of ['error', 'aborted']) {
    const result = { finish: { kind }, text: 'whatever' }
    assert.equal(classifyOutcome({ race: streamed(result), deadlineFired: false, aborted: false }), STATES.failed, kind)
  }
})

test('a race that never produced a stream is a failure', () => {
  assert.equal(classifyOutcome({ race: null, deadlineFired: false, aborted: false }), STATES.failed)
  assert.equal(classifyOutcome({ race: { kind: 'prepare' }, deadlineFired: false, aborted: false }), STATES.failed)
})

test('the reason names which observation produced the state', () => {
  assert.equal(terminalReason(STATES.timed_out, null), 'deadline')
  assert.equal(terminalReason(STATES.cancelled, null), 'cancelled-locally')
  assert.equal(terminalReason(STATES.no_advice, null), 'advisor-said-nothing-to-add')
  assert.equal(terminalReason(STATES.returned, STOPPED), null)
  assert.equal(terminalReason(STATES.failed, null), null)
})

test('two truncated records stay distinguishable by reason', () => {
  const budget = { finish: { kind: 'max-tokens' }, text: 'x' }
  const ceiling = { finish: { kind: 'stop' }, text: 'x' }
  assert.equal(terminalReason(STATES.truncated, budget), 'output-budget')
  assert.equal(terminalReason(STATES.truncated, ceiling), 'over-character-ceiling')
  assert.notEqual(terminalReason(STATES.truncated, budget), terminalReason(STATES.truncated, ceiling))
})
