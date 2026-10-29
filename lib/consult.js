/**
 * dsh-advisor v0.2 — one user-initiated consultation, from press to record.
 *
 * The v0.1 tool is a *model*-initiated consultation: the working model decides
 * it wants a second opinion, and the user only sees a consent prompt. v0.2 adds
 * the opposite direction — the user points at something and asks. That is a
 * different feature, not a different button, and the difference lives here:
 *
 *   - the request is assembled from materials the user approved, not from the
 *     model's paraphrase of them;
 *   - the record is written before the request leaves, so a crash mid-call
 *     leaves evidence rather than a phantom;
 *   - every terminal state is reachable and named, including the ones that look
 *     like failure but are not (no-advice, cancelled, timed-out, truncated);
 *   - nothing here retries. A user who wants another opinion asks again, and
 *     gets a second record; an auto-retry would double-bill a request the user
 *     believed was one call.
 *
 * Cancellation deserves a note. `cancel()` stops *our* wait. It cannot promise
 * the provider stopped generating, so the record says `cancelled` and the note
 * says the wait ended locally — claiming a remote stop would be a lie the user
 * cannot check.
 */

import {
  buildAdvisorSystemPrompt,
  classifyUsage,
  collectStream,
  combineSignals,
  parseAdvice,
  raceStream,
} from './advisor.js'
import { collectMaterials, describeMaterials, digestFiles } from './materials.js'
import { openHistory, compareMaterials, STATES, VERIFICATION, DISPOSITION } from './history.js'
import { effectiveMode, resolveConsultTarget } from './settings.js'

/** Longest single stretch the UI shows before it stops calling it "starting". */
const PREPARE_TIMEOUT_MS = 15000

/**
 * The system prompt for a user-initiated review.
 *
 * Deliberately not the tool's prompt. The tool's advisor answers a narrow
 * question from another model and is told to be terse; a user-requested review
 * has to be usable by the person who asked, on its own, without that model
 * standing between them and the answer. So it asks for structure — what is
 * wrong, on what evidence, how to check, whether the fix widens the change —
 * because those four are exactly the questions a review must answer to be
 * actionable, and they are the four a plausible-sounding review skips.
 *
 * It also forbids the two failure modes that make an advisor worthless:
 * restating the materials back at the reader, and inventing a defect to seem
 * useful. `NO_ADVICE` stays available for the honest case.
 */
function buildReviewSystemPrompt(focus, language) {
  const subject = {
    plan: 'the current plan and how it is being carried out',
    diff: 'the code changes shown',
    test: 'the failing test output and what caused it',
    general: 'the work described',
  }[focus] ?? 'the work described'
  const reply = language === 'en' ? 'English' : '简体中文'
  return [
    `You are reviewing ${subject} for the person who asked. Another model is doing the work; you are not.`,
    `Reply in ${reply}.`,
    '',
    'Write for someone who will act on this without asking you follow-up questions:',
    '1. Start with the single most important finding in one or two sentences. If there is nothing worth reporting, say that plainly instead of padding.',
    '2. Then list findings, each as: what is wrong — on what evidence (quote or name the material) — how to check it — whether fixing it widens the change.',
    '3. Separate what you can see from what you are assuming. If the materials do not cover something you would need, say so instead of guessing.',
    '4. Say explicitly if a finding would change the acceptance criteria, the scope, or the user-visible behaviour.',
    '',
    'Do not restate the materials back at the reader; they wrote them.',
    'Do not invent a problem to appear useful. A review that finds nothing must say so.',
    'If you have no useful opinion at all, reply exactly NO_ADVICE.',
  ].join('\n')
}

/** A short human line for the record, so the history list needs no decoding. */
function summarizeAdvice(parsed) {
  const text = String(parsed.text || '').replace(/\s+/gu, ' ').trim()
  if (text === '') return ''
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/**
 * Decide the outcome from what the stream actually did.
 *
 * Kept as one function because the alternative — deciding inside the call site —
 * is how the v0.1 tool ended up with a terminal state that disagreed with its
 * own return value. Every branch here names a different *observation*:
 *
 *   returned      text arrived and it is an opinion
 *   truncated     text arrived but the output budget cut it off
 *   no_advice     the model said it has nothing (a real answer, not a failure)
 *   timed_out     our deadline fired; whatever arrives later is not delivered
 *   cancelled     the user stopped waiting
 *   failed        the call broke; the reason is recorded verbatim
 *   refused       a guard stopped it before any request was issued
 */
function classifyOutcome({ race, deadlineFired, aborted }) {
  if (aborted) return deadlineFired ? STATES.timed_out : STATES.cancelled
  if (!race || race.kind !== 'stream') return STATES.failed
  const result = race.result
  if (!result) return STATES.failed
  if (!result.finish) return STATES.failed
  const kind = result.finish.kind
  if (kind === 'aborted' || kind === 'error') return STATES.failed
  if (kind === 'max-tokens') return STATES.truncated
  if (kind === 'stop') {
    const parsed = parseAdvice(result.text)
    if (parsed.kind === 'no-advice') return STATES.no_advice
    if (parsed.kind === 'empty') return STATES.failed
    if (parsed.kind === 'too-long') return STATES.truncated
    return STATES.returned
  }
  return STATES.failed
}

/**
 * The one-line reason stored beside a terminal state.
 *
 * The state says what happened; the reason says which observation produced it.
 * Two `truncated` records can come from completely different events — the output
 * budget ran out, or the answer was longer than the protocol ceiling — and the
 * difference matters, because only the first one is worth retrying with a bigger
 * budget. Same for `failed`: a provider error and an empty text both end there.
 *
 * Kept separate from `classifyOutcome` because the state must stay a pure
 * function of the wire observation, while the reason is allowed to look at the
 * result to name *which* observation it was.
 */
function terminalReason(state, result) {
  if (state === STATES.timed_out) return 'deadline'
  if (state === STATES.cancelled) return 'cancelled-locally'
  if (state === STATES.truncated) {
    return result?.finish?.kind === 'max-tokens' ? 'output-budget' : 'over-character-ceiling'
  }
  if (state === STATES.no_advice) return 'advisor-said-nothing-to-add'
  return null
}

/**
 * The consultation service.
 *
 * One instance per plugin mount. It owns no timers between calls and no polling
 * loop: a consultation is a promise that some caller is already awaiting, and
 * when the plugin unloads, `unloadAll()` aborts whatever is in flight so the
 * process can exit.
 */
export function createConsultService({
  llm,
  home,
  getSettings,
  saveSettings,
  getSession,
  getSessionSelection,
  workspaceChanges = null,
  log = () => {},
  language = 'zh',
}) {
  /** consultationId -> { controller, sessionId, record } */
  const inFlight = new Map()
  let seq = 0

  function historyFor(sessionId) {
    const settings = getSettings()
    return openHistory(home, sessionId, { limit: settings.advanced.historyLimit })
  }

  /**
   * Guard the run-level ceiling before any material is read.
   *
   * Checked against the recorded history rather than an in-memory counter: the
   * ceiling is a promise about the session, and an in-memory counter forgot
   * every consultation that happened before a reload — which is exactly when a
   * user is most likely to have spent the budget already.
   */
  function budgetState(sessionId) {
    const settings = getSettings()
    const history = historyFor(sessionId)
    const records = history.records
    const issued = records.filter((record) => record.state !== STATES.refused).length
    const ceiling = settings.advanced.maxConsultationsPerSession
    return { issued, ceiling, exhausted: ceiling > 0 && issued >= ceiling, history }
  }

  /**
   * How many consultations this session is already waiting on.
   *
   * A per-session ceiling, not a global one: two sessions belong to two
   * conversations and stopping one because the other is busy would be a
   * surprise. Without any ceiling, a client that resends on a stuck button can
   * stack up paid requests that nothing on screen distinguishes from one.
   */
  const MAX_IN_FLIGHT_PER_SESSION = 3

  function inFlightFor(sessionId) {
    let count = 0
    for (const [, entry] of inFlight) {
      if (entry.sessionId === sessionId) count += 1
    }
    return count
  }

  /**
   * Start a consultation. Returns immediately with the record; progress is
   * reported through the returned record object and through history updates.
   */
  async function start({ sessionId, request }) {
    seq += 1
    const settings = getSettings()
    const history = historyFor(sessionId)
    const mode = effectiveMode(settings, sessionId)
    const at = new Date().toISOString()
    const consultationId = `c${Date.now().toString(36)}-${seq}`

    const target = resolveConsultTarget(settings, getSessionSelection(sessionId))
    const focus = ['plan', 'diff', 'test', 'general'].includes(request?.focus) ? request.focus : 'general'

    const base = {
      id: consultationId,
      sessionId,
      createdAt: at,
      settledAt: null,
      state: STATES.preparing,
      mode,
      focus,
      question: typeof request?.question === 'string' ? request.question.trim() : '',
      target: { provider: target.provider, model: target.model, source: target.source },
      delivery: settings.delivery,
      origin: request?.origin === 'model' ? 'model' : 'user',
    }

    // Master switch first: an unloaded feature must not spend a model call or
    // read materials, and the refusal has to say which switch did it.
    if (settings.enabled === false) {
      const record = history.put({
        ...base,
        state: STATES.refused,
        settledAt: new Date().toISOString(),
        reason: 'disabled',
        error: { code: 'disabled', message: '顾问已关闭：可在设置 → 插件 → 顾问 里重新开启。' },
      })
      return { record, accepted: false }
    }

    // Budget first: a refusal here costs nothing and must not read materials.
    const budget = budgetState(sessionId)
    if (budget.exhausted) {
      const record = history.put({
        ...base,
        state: STATES.refused,
        settledAt: new Date().toISOString(),
        reason: 'session-budget-exhausted',
        error: {
          code: 'budget',
          message: `本会话已咨询 ${budget.issued} 次，达到上限 ${budget.ceiling}。可在设置里提高上限。`,
        },
      })
      return { record, accepted: false }
    }

    // Then the in-flight ceiling. Three at once is already more than a person can
    // read; past that the extra request is indistinguishable on screen but
    // identical on the invoice, so it is refused while the reason is still
    // visible rather than queued out of sight.
    const waiting = inFlightFor(sessionId)
    if (waiting >= MAX_IN_FLIGHT_PER_SESSION) {
      const record = history.put({
        ...base,
        state: STATES.refused,
        settledAt: new Date().toISOString(),
        reason: 'too-many-in-flight',
        error: {
          code: 'too-many-in-flight',
          message: `本会话已有 ${waiting} 个咨询在等，先等其中一个结束（或取消）再发起。`,
        },
      })
      return { record, accepted: false }
    }

    if (target.source === 'missing' || !target.provider || !target.model) {
      const record = history.put({
        ...base,
        state: STATES.refused,
        settledAt: new Date().toISOString(),
        reason: 'no-model',
        error: {
          code: 'no-model',
          message: '没有可用的顾问模型：请先在设置里选定 provider 与 model，或让本会话有一个默认模型。',
        },
      })
      return { record, accepted: false }
    }

    if (base.question === '') {
      const record = history.put({
        ...base,
        state: STATES.refused,
        settledAt: new Date().toISOString(),
        reason: 'empty-question',
        error: { code: 'empty-question', message: '请先写下要顾问关注的问题。' },
      })
      return { record, accepted: false }
    }

    // The record exists before the request does. If the process dies during the
    // call, the history still shows that a consultation was attempted, with the
    // model and materials it was about to use.
    const record = history.put({ ...base, materials: { kinds: [], chars: 0, files: {} } })

    const session = getSession(sessionId)
    const controller = new AbortController()
    // `initiator` records who stopped the wait first. It cannot be derived after
    // the fact: once the abort fires, a user cancel and an exhausted deadline
    // look identical on the wire, and both signals stay aborted. Whoever gets
    // there first names the event; a later arrival must not rename it.
    const entry = { controller, sessionId, record, deadlineTimer: null, initiator: null }
    inFlight.set(consultationId, entry)

    const prepared = await collectMaterials({
      settings,
      session,
      sessionId,
      request,
      workspaceChanges,
      signal: controller.signal,
      cwd: session?.cwd ?? null,
    })

    if (!prepared.ok) {
      inFlight.delete(consultationId)
      const refused = history.patch(consultationId, {
        state: STATES.refused,
        settledAt: new Date().toISOString(),
        reason: prepared.reason || 'empty-question',
        error: { code: prepared.reason || 'empty-question', message: '材料为空，未发出请求。' },
      })
      return { record: refused, accepted: false }
    }

    const kinds = prepared.materials.filter((m) => !m.absent && m.chars > 0).map((m) => m.kind)
    const running = history.patch(consultationId, {
      state: STATES.running,
      materials: {
        kinds,
        chars: prepared.chars,
        files: prepared.files,
        changeCount: prepared.changeCount,
        changeToken: prepared.changeToken,
        digest: prepared.digest,
        summary: describeMaterials(prepared.materials),
        absent: prepared.materials
          .filter((m) => m.absent)
          .map((m) => ({ kind: m.kind, reason: m.reason })),
        truncated: prepared.materials.filter((m) => m.truncated).map((m) => m.kind),
        fromEarlierTurn: prepared.materials.filter((m) => m.fromEarlierTurn).map((m) => m.kind),
      },
    })

    const detail = { provider: target.provider, model: target.model, source: target.source }
    log('consult-start', { consultationId, sessionId, focus, ...detail, chars: prepared.chars })

    // The request carries the assembled text, which is the same text the user
    // previewed. `prepared.digest` is stored beside it so a later "the code
    // moved" check can prove the difference came from the session, not from a
    // different assembly.
    const run = (async () => {
      const deadlineMs = settings.advanced.consultDeadlineMs
      let deadlineController = null
      try {
        if (deadlineMs > 0) {
          deadlineController = new AbortController()
          entry.deadlineTimer = setTimeout(() => {
            if (entry.initiator === null) entry.initiator = 'deadline'
            deadlineController.abort()
          }, deadlineMs)
          if (entry.deadlineTimer && typeof entry.deadlineTimer.unref === 'function') {
            entry.deadlineTimer.unref()
          }
        }
        const signal = combineSignals([controller.signal, deadlineController?.signal ?? null])
        const streamPromise = collectStream(
          llm.stream({
            provider: target.provider,
            model: target.model,
            system: buildReviewSystemPrompt(focus, language),
            messages: [{ role: 'user', content: [{ type: 'text', text: prepared.text }] }],
            maxTokens: settings.advanced.maxAdviceTokens,
            signal,
            ...(sessionId ? { sessionId } : {}),
          }),
        )
        streamPromise.catch(() => {})

        let race = null
        let error = null
        try {
          race = await raceStream(streamPromise, signal, 300)
        } catch (err) {
          error = err
        }

        const aborted = Boolean(race && race.kind === 'aborted')
        let state = classifyOutcome({ race, deadlineFired: entry.initiator === 'deadline', aborted })
        const result = race && race.kind === 'stream' ? race.result : null
        const parsed = result ? parseAdvice(result.text) : { kind: 'empty', text: '', chars: 0 }

        const usage = classifyUsage({
          chunkSeen: Boolean(result && result.usageChunkSeen),
          usage: result?.usage ?? null,
        })

        let errorField = null
        if (state === STATES.failed) {
          if (error) {
            errorField = { code: 'exception', message: String(error?.message || error) }
          } else if (!result || !result.finish) {
            errorField = { code: 'no-finish', message: '流在没有 finish 的情况下结束，无法据此形成意见。' }
          } else if (result.finish.kind === 'aborted' || result.finish.kind === 'error') {
            const failure = result.finish.failure || {}
            errorField = {
              code: failure.code || result.finish.kind,
              message: failure.message || `顾问调用结束于 ${result.finish.kind}`,
              ...(failure.status ? { status: failure.status } : {}),
            }
          } else if (parsed.kind === 'empty') {
            errorField = { code: 'empty', message: '顾问返回了空文本。' }
          }
        }
        const reason = terminalReason(state, result)

        // A cut-off answer is still an answer. Keeping the text is the whole
        // point of separating `truncated` from `failed`: the user paid for it.
        const keepText = state === STATES.returned || state === STATES.truncated || state === STATES.no_advice

        const settledRecord = history.patch(consultationId, {
          state,
          settledAt: new Date().toISOString(),
          advice: keepText ? parsed.text : '',
          adviceChars: keepText ? parsed.chars : 0,
          summary: keepText ? summarizeAdvice(parsed) : '',
          finishKind: result?.finish?.kind ?? null,
          reason,
          error: errorField,
          usage: {
            inputTokens: usage.usageRaw?.inputTokens ?? null,
            outputTokens: usage.usageRaw?.outputTokens ?? null,
            totalTokens: usage.usageRaw?.totalTokens ?? null,
          },
          usageOrigin: usage.usageOrigin,
          // The advice was produced against the materials as assembled. Storing
          // the digest here is what lets the card later say "this is about an
          // older version" instead of quietly presenting stale review as current.
          adviceDigest: prepared.digest,
        })
        log('consult-settle', { consultationId, state, chars: parsed.chars, reason })
        return settledRecord
      } catch (err) {
        const failedRecord = history.patch(consultationId, {
          state: STATES.failed,
          settledAt: new Date().toISOString(),
          error: { code: 'unexpected', message: String(err?.message || err) },
        })
        log('consult-error', { consultationId, message: String(err?.message || err) })
        return failedRecord
      } finally {
        if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer)
        inFlight.delete(consultationId)
      }
    })()

    return { record: running, accepted: true, done: run, materials: prepared }
  }

  /**
   * Stop waiting for one consultation.
   *
   * Only local: the record says `cancelled` and its note says the wait ended,
   * because this code cannot observe the provider. Saying "stopped at the
   * provider" would be unverifiable from here.
   */
  function cancel(sessionId, consultationId) {
    const entry = inFlight.get(consultationId)
    if (!entry || entry.sessionId !== sessionId) {
      return { ok: false, reason: 'not-running' }
    }
    // Claim the event before aborting, and disarm the deadline so it cannot fire
    // during the cancel grace window and rename this cancel a timeout.
    if (entry.initiator === null) entry.initiator = 'user'
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer)
    entry.controller.abort()
    return { ok: true }
  }

  function abortAll() {
    for (const [, entry] of inFlight) {
      try {
        entry.controller.abort()
      } catch {
        /* nothing useful to do while unloading */
      }
    }
    inFlight.clear()
  }

  /**
   * Is this advice still about the code it was written about?
   *
   * Two independent signals, both cheap and both local:
   *
   *  - the files that were actually sent are re-hashed now. If any differs, the
   *    advice is about text that no longer exists, and no amount of the advisor
   *    being right about the old text makes it right about the new one.
   *  - the turn's changed-file count moved. A digest can miss a file that was
   *    never in the original set, so the count catches growth the hashes cannot.
   *
   * When neither signal can be computed the answer is `unknown`, never
   * `unchanged`. Treating "I could not check" as "it is fine" is precisely the
   * failure this feature exists to prevent.
   */
  function stalenessOf(record, sessionId) {
    const files = record?.materials?.files
    const recorded = files && typeof files === 'object' ? files : null
    let currentChangeCount = null
    if (workspaceChanges && typeof workspaceChanges.summary === 'function') {
      try {
        const events = sessionEvents(sessionId)
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index] && events[index].type === 'workspace/changes') {
            const summary = workspaceChanges.summary(sessionId, events[index].seq)
            if (summary && Number.isFinite(summary.total)) currentChangeCount = summary.total
            break
          }
        }
      } catch {
        currentChangeCount = null
      }
    }
    if (!record || record.state === STATES.refused || !record.settledAt) {
      return { verdict: 'unknown', changedPaths: [] }
    }
    // Re-hash exactly the paths that were sent. Hashing the whole workspace would
    // report "changed" whenever anything anywhere moved, which trains the user to
    // ignore the marker.
    const nowDigests = recorded && Object.keys(recorded).length > 0 ? digestFiles(Object.keys(recorded)) : null
    return compareMaterials(record, nowDigests, currentChangeCount)
  }

  function sessionEvents(sessionId) {
    try {
      const session = getSession(sessionId)
      if (!session || typeof session.snapshotEvents !== 'function') return []
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }

  /** Consultations for one session, newest first, plus the staleness verdict. */
  function list(sessionId) {
    const history = historyFor(sessionId)
    const records = history.records
    return records
      .slice()
      .reverse()
      .map((record) => ({ ...record, staleness: stalenessOf(record, sessionId) }))
  }

  function get(sessionId, consultationId) {
    const history = historyFor(sessionId)
    const record = history.get(consultationId)
    if (!record) return null
    return { ...record, staleness: stalenessOf(record, sessionId) }
  }

  /**
   * Record what happened to an opinion after it was delivered.
   *
   * Three separate facts, deliberately not one field: whether the working model
   * confirmed the finding, whether anything was changed, and whether the change
   * was verified. Collapsing them into "accepted" is how a rejected-and-fixed
   * finding gets counted as agreement.
   */
  function annotate(sessionId, consultationId, patch) {
    const history = historyFor(sessionId)
    const existing = history.get(consultationId)
    if (!existing) return null
    const changes = {}
    if (patch.verification && VERIFICATION[patch.verification]) {
      changes.verification = patch.verification
      // A verdict without a note is an assertion without evidence; the note is
      // how a later reader knows whether the model actually checked.
      if (typeof patch.verdictNote === 'string') changes.verdictNote = patch.verdictNote
    }
    if (patch.disposition && DISPOSITION[patch.disposition]) changes.disposition = patch.disposition
    if (typeof patch.staleAcknowledged === 'boolean') changes.staleAcknowledged = patch.staleAcknowledged
    // Delivery is recorded separately from verification and disposition: "the
    // working model has seen this" is not "the working model agreed", and the
    // card must be able to show the first without implying the second.
    if (patch.delivered === true) changes.deliveredToModel = true
    if (Object.keys(changes).length === 0) return existing
    return history.patch(consultationId, changes)
  }

  function clear(sessionId) {
    const history = historyFor(sessionId)
    history.clear()
    return { ok: true }
  }

  return { start, cancel, abortAll, list, get, annotate, clear, inFlightCount: () => inFlight.size }
}

export { PREPARE_TIMEOUT_MS, buildReviewSystemPrompt, classifyOutcome, terminalReason }
