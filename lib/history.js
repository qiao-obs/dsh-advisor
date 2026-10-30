/**
 * dsh-advisor v0.2 — per-session consultation history.
 *
 * Why this is a separate store and not session events: the session log is the
 * host's, and a plugin may not append new event types to it (practices.md). The
 * plugin's own record of "what was asked, what came back, and what happened
 * afterwards" therefore lives beside the settings file, keyed by session id.
 *
 * The rules this file enforces, and why each one exists:
 *
 * 1. One record per consultation, written when it opens and patched when it
 *    settles. A consultation that is still running must be visible, or the user
 *    cannot tell "slow" from "silently dropped".
 *
 * 2. The record stores the MATERIAL VERSION it was based on — the file digests
 *    and the workspace change count captured at send time. Without that, a
 *    result card cannot honestly say "the code has moved since this was written",
 *    and a stale opinion looks identical to a fresh one.
 *
 * 3. The lifecycle has four separate facts, not one status: was the advice
 *    delivered, did the main model verify it, what did verification conclude, and
 *    was anything acted on. Collapsing them is how "顾问说是问题" turns into
 *    "问题已修复" without anyone checking.
 *
 * 4. "Untouched" is a real state and means "no reliable evidence that anything
 *    happened" — never "not important".
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCandidates } from './action-candidates.js'

export const HISTORY_VERSION = 1

/** Consultation states. Every one comes from an observed event, never a timer. */
export const STATES = {
  /** Materials are being assembled; nothing was sent. */
  preparing: 'preparing',
  /** Waiting for the human to confirm. */
  awaiting: 'awaiting',
  /** The request is in flight. */
  running: 'running',
  /** A usable answer arrived. */
  returned: 'returned',
  /** An answer arrived but was cut off by the output budget. */
  truncated: 'truncated',
  /** The advisor replied NO_ADVICE. */
  no_advice: 'no_advice',
  /** Ran past its budget. */
  timed_out: 'timed_out',
  /** The user cancelled locally. */
  cancelled: 'cancelled',
  /** The provider or the transport failed. */
  failed: 'failed',
  /** Refused before any request: no target, no consent, no budget. */
  refused: 'refused',
}

/** Verification outcomes, as reported by the model or by the user. */
export const VERIFICATION = {
  /** Nobody has said anything about it. */
  pending: 'pending',
  /** The main model checked and agreed the concern is real. */
  confirmed: 'confirmed',
  /** The main model checked and found the concern does not apply. */
  rejected: 'rejected',
  /** Checked, but the evidence did not settle it either way. */
  inconclusive: 'inconclusive',
}

/** What was done with a confirmed concern. */
export const DISPOSITION = {
  none: 'none',
  accepted: 'accepted',
  fixed: 'fixed',
  deferred: 'deferred',
}

const MAX_TEXT = 20000

function str(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? value.slice(0, limit) : value
}

function num(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Timestamps are stored as ISO strings because that is what a human reading the
 * history file should see, and what `new Date(...)` accepts on the client. They
 * must survive normalization as strings: an earlier version ran them through
 * `num()`, which silently rewrote every timestamp to `0` — the wait counter then
 * measured from 1970 and the staleness check, which requires a settled time,
 * reported `unknown` forever. Epoch numbers are accepted on read so records
 * written by that version are repaired rather than discarded.
 */
function iso(value, fallback = null) {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString()
  }
  if (Number.isFinite(value) && value > 0) return new Date(value).toISOString()
  return fallback
}

/**
 * A digest map is `{ [path]: 'sha256:...' }`. Only the paths that were actually
 * sent are kept — storing every file in the workspace would make the history
 * file grow with the project instead of with the consultations.
 */
function digestMap(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [path, digest] of Object.entries(raw)) {
    if (typeof digest === 'string' && digest !== '') out[str(path, 400)] = digest
  }
  return out
}

/** Coerce one stored record into the current shape. */
export function normalizeRecord(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const state = Object.values(STATES).includes(source.state) ? source.state : STATES.failed
  const materials = source.materials && typeof source.materials === 'object' ? source.materials : {}
  return {
    id: str(source.id, 200),
    sessionId: str(source.sessionId, 200),
    createdAt: iso(source.createdAt, null),
    settledAt: iso(source.settledAt, null),
    state,
    mode: source.mode === 'auto' || source.mode === 'confirm' ? source.mode : 'manual',
    focus: str(source.focus, 40) || 'general',
    workItemId: str(source.workItemId, 200) || null,
    actions: state === STATES.returned ? normalizeCandidates(source.actions) : [],
    question: str(source.question),
    target: {
      provider: str(source.target && source.target.provider, 200) || null,
      model: str(source.target && source.target.model, 200) || null,
      source: source.target && source.target.source === 'fixed' ? 'fixed' : 'session',
    },
    materials: {
      kinds: Array.isArray(materials.kinds) ? materials.kinds.filter((k) => typeof k === 'string') : [],
      chars: num(materials.chars, 0),
      /** Digests of the files whose content was sent, for staleness checks. */
      files: digestMap(materials.files),
      /** Workspace change count at send time; null when it could not be read. */
      changeCount: num(materials.changeCount, null),
      /** Workspace change set identity, when the host exposed one. */
      changeToken: str(materials.changeToken, 400) || null,
      digest: str(materials.digest, 200) || null,
      summary: str(materials.summary, 2000),
      truncated: Array.isArray(materials.truncated) ? materials.truncated.filter(k => typeof k === 'string') : [],
      fromEarlierTurn: Array.isArray(materials.fromEarlierTurn) ? materials.fromEarlierTurn.filter(k => typeof k === 'string') : [],
      absent: Array.isArray(materials.absent) ? materials.absent.filter(m => m && typeof m === 'object').map(m => ({ kind: str(m.kind, 40), reason: str(m.reason, 2000) })) : [],
    },
    origin: source.origin === 'model' ? 'model' : 'user',
    summary: str(source.summary, 400),
    adviceDigest: str(source.adviceDigest, 200) || null,
    advice: state === STATES.no_advice ? '' : str(source.advice),
    adviceChars: num(source.adviceChars, 0),
    /** `stop` | `max-tokens` | `aborted` | `error` | null */
    finishKind: str(source.finishKind, 40) || null,
    /** Why it ended, in the plugin's words, when the state is not `returned`. */
    reason: str(source.reason, 2000) || null,
    error: source.error && typeof source.error === 'object'
      ? {
          code: str(source.error.code, 100) || null,
          message: str(source.error.message, 2000) || null,
          status: num(source.error.status, null),
        }
      : null,
    usage: source.usage && typeof source.usage === 'object'
      ? {
          inputTokens: num(source.usage.inputTokens, null),
          outputTokens: num(source.usage.outputTokens, null),
          totalTokens: num(source.usage.totalTokens, null),
        }
      : null,
    /** Where the usage numbers came from; `unknown` unless the transport said. */
    usageOrigin: ['provider-reported', 'adapter-default', 'adapter-estimated'].includes(source.usageOrigin)
      ? source.usageOrigin
      : 'unknown',
    delivery: source.delivery === 'return' ? 'return' : 'show',
    /** True once the advice has been handed back to the working model. */
    deliveredToModel: source.deliveredToModel === true,
    verification: Object.values(VERIFICATION).includes(source.verification)
      ? source.verification
      : VERIFICATION.pending,
    verdictNote: str(source.verificationNote ?? source.verdictNote, 4000) || null,
    disposition: Object.values(DISPOSITION).includes(source.disposition)
      ? source.disposition
      : DISPOSITION.none,
    /** Free-form trailing notes, newest last. */
    notes: Array.isArray(source.notes)
      ? source.notes
          .filter((n) => n && typeof n === 'object')
          .slice(-50)
          .map((n) => ({ at: num(n.at, 0), kind: str(n.kind, 40), text: str(n.text, 2000) }))
      : [],
    /** Which stale-marker, if any, the user has already dismissed. */
    staleAcknowledged: source.staleAcknowledged === true,
  }
}

/** Path of one session's history file. */
export function historyPath(home, sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]+/g, '_')
  return join(home, 'dsh-advisor', 'sessions', `${safe}.json`)
}

function readFileSafe(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Open one session's history.
 *
 * The whole file is small (advice text for the last N consultations), so it is
 * refreshed before each operation and written back on every mutation. No timers, no async
 * writer: a plugin that leaves a pending write behind after unload is a plugin
 * that can corrupt its own file.
 */
export function openHistory(home, sessionId, { limit = 50 } = {}) {
  const file = historyPath(home, sessionId)
  const state = { records: [], issuedCount: 0, limit: Math.max(5, limit) }
  // All reads and mutations are synchronous. Refresh before every operation so
  // separate handles in this host cannot overwrite each other's async results.
  // This is not an inter-process lock: a profile must have a single writer.
  const refresh = () => {
    const parsed = readFileSafe(file)
    state.records = Array.isArray(parsed?.records) ? parsed.records.map(normalizeRecord) : []
    const visibleIssued = state.records.filter(r => r.state !== STATES.refused).length
    state.issuedCount = Math.max(visibleIssued, Number.isSafeInteger(parsed?.issuedCount) ? parsed.issuedCount : 0)
  }
  refresh()

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true })
    const payload = { version: HISTORY_VERSION, sessionId, issuedCount: state.issuedCount, records: state.records }
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8')
    renameSync(temp, file)
  }

  /**
   * Drop old records once the session has more than `limit` of them.
   *
   * Oldest first, but never a record that is still pending or still owes a
   * verdict: those are the only records that represent work a person has to do,
   * and silently rotating them out of a 50-record window would delete a question
   * they were about to answer. When every record is owed, the limit is exceeded
   * rather than satisfied.
   */
  const stillOwed = (record) =>
    record.state === STATES.preparing ||
    record.state === STATES.awaiting ||
    record.state === STATES.running ||
    (Boolean(record.advice) && record.verification !== 'confirmed' && record.verification !== 'rejected')
  const trim = () => {
    // Oldest first: the newest records are the ones a person is looking at.
    let excess = state.records.length - state.limit
    if (excess <= 0) return
    state.records = state.records.filter((record) => {
      if (excess <= 0) return true
      if (stillOwed(record)) return true
      excess -= 1
      return false
    })
  }

  return {
    file,
    get records() {
      refresh()
      return state.records
    },
    get issuedCount() {
      refresh()
      return state.issuedCount
    },
    // Model-initiated consultations use their own tool ledger. Reserve their
    // budget here too, so switching entry points cannot bypass the session cap.
    reserve() {
      refresh()
      state.issuedCount += 1
      persist()
    },
    refund() {
      refresh()
      const visible = state.records.filter(r => r.state !== STATES.refused).length
      state.issuedCount = Math.max(visible, state.issuedCount - 1)
      persist()
    },
    get(id) {
      refresh()
      return state.records.find((record) => record.id === id) || null
    },
    /** Insert or replace one record, preserving insertion order. */
    put(record) {
      refresh()
      const normalized = normalizeRecord(record)
      const index = state.records.findIndex((existing) => existing.id === normalized.id)
      const beforeCounted = index >= 0 && state.records[index].state !== STATES.refused
      const afterCounted = normalized.state !== STATES.refused
      state.issuedCount += Number(afterCounted) - Number(beforeCounted)
      if (index >= 0) state.records[index] = normalized
      else state.records.push(normalized)
      trim()
      persist()
      return normalized
    },
    /** Patch one record; unknown ids are ignored rather than resurrected. */
    patch(id, changes) {
      refresh()
      const index = state.records.findIndex((record) => record.id === id)
      if (index < 0) return null
      const merged = normalizeRecord({
        ...state.records[index],
        ...changes,
        materials: { ...state.records[index].materials, ...(changes.materials || {}) },
        target: { ...state.records[index].target, ...(changes.target || {}) },
      })
      state.issuedCount += Number(merged.state !== STATES.refused) - Number(state.records[index].state !== STATES.refused)
      state.records[index] = merged
      trim()
      persist()
      return merged
    },
    /** Append one note and persist. */
    note(id, kind, text) {
      refresh()
      const record = state.records.find((entry) => entry.id === id)
      if (!record) return null
      record.notes.push({ at: Date.now(), kind: str(kind, 40), text: str(text, 2000) })
      record.notes = record.notes.slice(-50)
      persist()
      return record
    },
    clear() {
      refresh()
      // Removing the review history does not reset the spending ceiling.
      state.records = []
      persist()
    },
  }
}

/**
 * Has the material this consultation was based on moved since?
 *
 * Three answers, not two, because "I could not check" is not "unchanged":
 *
 *   `unchanged` — every sent file still has the same digest
 *   `changed`   — at least one sent file differs, or was deleted
 *   `unknown`   — nothing was recorded to compare against
 *
 * The caller renders `changed` as "基于旧版本，需重新核验". It must not render
 * `unknown` that way: a consultation of a bare question never looked at a file,
 * and calling that stale would teach the user to ignore the marker.
 */
export function compareMaterials(record, currentDigests, currentChangeCount = null) {
  const files = record && record.materials ? record.materials.files : null
  const known = files ? Object.keys(files) : []
  if (known.length === 0) {
    // No file evidence. A workspace-change count is a weaker signal but still a
    // real one, so it is used when both sides have it.
    const before = record && record.materials ? record.materials.changeCount : null
    if (before !== null && currentChangeCount !== null) {
      return before === currentChangeCount
        ? { verdict: 'unchanged', changedPaths: [] }
        : { verdict: 'changed', changedPaths: [] }
    }
    return { verdict: 'unknown', changedPaths: [] }
  }
  if (!currentDigests) return { verdict: 'unknown', changedPaths: [] }
  const changedPaths = []
  for (const path of known) {
    const now = currentDigests[path]
    if (now === undefined || now !== files[path]) changedPaths.push(path)
  }
  return changedPaths.length > 0
    ? { verdict: 'changed', changedPaths }
    : { verdict: 'unchanged', changedPaths: [] }
}
