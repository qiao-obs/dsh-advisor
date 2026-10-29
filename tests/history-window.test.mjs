// The rolling window must never throw away work a person still owes.
//
// `historyLimit` is a storage budget, not a statement that older consultations
// stopped mattering. An opinion that arrived and was never verified is the one
// record whose whole purpose is to be acted on later, so rotation has to skip it
// and overflow instead — a silently deleted question is worse than a big file.
//
// Note: `openHistory` clamps the window to a floor of 5, so every test here uses
// 5 or more. A test at limit 2 would never trim and would pass for the wrong
// reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHistory, STATES, VERIFICATION } from '../lib/history.js'

const LIMIT = 5

function home() {
  return mkdtempSync(join(tmpdir(), 'dsh-advisor-trim-'))
}

function record(id, extra = {}) {
  return {
    id,
    sessionId: 's1',
    state: STATES.returned,
    advice: `advice ${id}`,
    verification: VERIFICATION.confirmed,
    ...extra,
  }
}

function ids(history) {
  return history.records.map((entry) => entry.id)
}

test('the window keeps the newest records and drops the oldest', () => {
  const dir = home()
  try {
    const history = openHistory(dir, 's1', { limit: LIMIT })
    for (let i = 0; i < 8; i += 1) history.put(record(`r${i}`))
    assert.deepEqual(ids(history), ['r3', 'r4', 'r5', 'r6', 'r7'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unverified opinion survives the window even when it is the oldest', () => {
  const dir = home()
  try {
    const history = openHistory(dir, 's1', { limit: LIMIT })
    history.put(record('owed', { verification: VERIFICATION.pending }))
    for (let i = 0; i < 8; i += 1) history.put(record(`r${i}`))
    const kept = ids(history)
    assert.ok(kept.includes('owed'), `the owed record was rotated out: ${kept.join(',')}`)
    // Oldest verified records go first, and the limit is exceeded rather than
    // satisfied: five verified plus the one still owed.
    assert.deepEqual(kept, ['owed', 'r4', 'r5', 'r6', 'r7'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejected or confirmed verdict is no longer owed', () => {
  const dir = home()
  try {
    const history = openHistory(dir, 's1', { limit: LIMIT })
    history.put(record('rejected', { verification: VERIFICATION.rejected }))
    history.put(record('confirmed', { verification: VERIFICATION.confirmed }))
    for (let i = 0; i < 7; i += 1) history.put(record(`r${i}`))
    assert.deepEqual(ids(history), ['r2', 'r3', 'r4', 'r5', 'r6'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an in-flight consultation is never rotated out mid-flight', () => {
  const dir = home()
  try {
    const history = openHistory(dir, 's1', { limit: LIMIT })
    history.put(record('running', { state: STATES.running, advice: null }))
    for (let i = 0; i < 8; i += 1) history.put(record(`r${i}`))
    assert.ok(ids(history).includes('running'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a record with no advice is not owed', () => {
  const dir = home()
  try {
    const history = openHistory(dir, 's1', { limit: LIMIT })
    history.put(record('failed', { state: STATES.failed, advice: null, verification: VERIFICATION.pending }))
    for (let i = 0; i < 8; i += 1) history.put(record(`r${i}`))
    assert.deepEqual(ids(history), ['r3', 'r4', 'r5', 'r6', 'r7'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
