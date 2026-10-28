/**
 * The minimal advisor closed loop:
 *
 *   tool call  ->  consent  ->  consultation  ->  advice  ->  record
 *
 * This is deliberately small. It is the shape a real plugin would have, not the
 * product. Every rule here exists because a measurement came first, and the
 * reasoning is inlined at each decision rather than cited to a document that is
 * not shipped. Where a comment mentions `mNNNNN`, that is an entry in the
 * development record; it is kept so the claim can be traced back to the
 * observation that produced it, and it is not needed to read the code.
 *
 * Decisions encoded here, and why:
 *
 * 1. `consultationId` is minted at THIS call site from `exec.callId`. m01508
 *    required attribution to come from the entry point, never from time
 *    adjacency or a mutable global "active advice id".
 *
 * 2. The consultation request is HAND-BUILT, not loop-built. That is legal and
 *    necessary: `llm/stream` listeners may read a loop-built request but the
 *    contract forbids rewriting it, and a hand-built request is the caller's own.
 *
 * 3. Attribution lives in the LOCAL LEDGER, not in the request text. m02026 was
 *    explicit about this: a changing `consultationId` inside the production
 *    system prompt alters the request on every call, which is exactly the kind
 *    of byte-level churn that can defeat prefix reuse later. So the marker is
 *    OFF by default and exists only as a probe affordance (`markSystemPrompt`).
 *    The ledger join is: callId -> consultationId -> response -> usage.
 *
 * 4. Consent is a hard gate, not a warning. If consent cannot be obtained, NO
 *    request is issued — the tool returns a refusal. m01508: "无法取得必要授权
 *    时不得发起请求."
 *
 * 5. `askTimed` is used rather than `ask`, because `ask` waits indefinitely for
 *    an answerer. Measured: with no answerer, `askTimed` settles as
 *    `{pending: true}` inside its window instead of hanging. But m02026 is right
 *    that this proves only the no-answerer case. `pending` is treated as NOT
 *    AUTHORIZED, and the full taxonomy is: allowed | denied | pending |
 *    cancelled | error. Only `allowed` issues a request.
 *
 * 6. A late Allow cannot restart a consultation. Once the tool has returned, the
 *    consultation is closed in the ledger; any later answer for that callId is
 *    recorded as `late-allow-ignored` and issues nothing.
 */

export const ADVISOR_TOOL_NAME = 'advisor_consult';

/** Focus values the tool accepts. Anything else is a caller bug. */
export const ADVISOR_FOCUS = ['plan', 'diff', 'test', 'general'];

/** Scopes pre-authorized by configuration, so the common case asks nobody. */
export const DEFAULT_AUTHORIZED_SCOPES = ['plan'];

const CONSULTATION_MARKER = /\[consultationId=([A-Za-z0-9_.:-]+)\]/;

/**
 * Pull the consultation id back out of a wire request.
 *
 * Only meaningful when the probe explicitly turned the marker on. In a real
 * plugin the system prompt must be stable across calls, so nothing reads this.
 */
export function consultationIdFromRequest(request) {
  const system = request && typeof request.system === 'string' ? request.system : '';
  const hit = CONSULTATION_MARKER.exec(system);
  return hit ? hit[1] : null;
}

/**
 * Build the system prompt for a consultation.
 *
 * `marker` is a probe-only affordance and defaults to off. See decision 3 in the
 * module header: putting a per-call id in the system prompt changes the request
 * on every call, which is the opposite of what a cache-friendly design wants.
 */
export function buildAdvisorSystemPrompt(focus, marker = null) {
  const lines = [
    'You are an advisor. Another model is doing the work; you review one decision.',
    `Focus: ${focus}.`,
    'Be brief: roughly three sentences. Name what you would check that the working model may have missed.',
    'If you have nothing useful to add, reply exactly NO_ADVICE.',
  ];
  if (marker) lines.push(`[consultationId=${marker}]`);
  return lines.join('\n');
}

/**
 * The advisor output contract, as stated to the model in the system prompt.
 *
 * m04570: brevity is a REQUEST, not a hard gate. The old rule counted sentences
 * by natural-language punctuation and threw the whole response away when the
 * count exceeded three. Real advisor text about code contains dots inside
 * identifiers, regex character classes, version numbers and URLs, so the count
 * fired on text that was entirely usable: three genuine responses (1097, 1311
 * and 1159 chars) were discarded this way on 2026-10-27. A format rule exists to
 * make advice consumable; when the content is still usable, a dot in a regex
 * class must not empty it.
 *
 * What is still enforced here: empty text is not advice, the NO_ADVICE token is
 * honoured, and absurdly long output is refused because it would blow the
 * consultation budget rather than inform a decision. Sentence counting is kept
 * for the record only — it is reported, never used to reject.
 */
export const ADVICE_PROTOCOL = {
  // Kept for backwards compatibility of recorded parse results and for
  // reporting. NOT a rejection threshold.
  maxSentences: 3,
  noAdviceToken: 'NO_ADVICE',
  // The real ceiling: a response longer than this is not a usable opinion, it is
  // a document. 400 tokens of advice is roughly 1600 chars; the limit sits above
  // that so a genuinely useful answer is never cut, while runaway output still
  // fails closed.
  maxChars: 4000,
};

/**
 * Decide what a consultation response actually is.
 *
 * m02196 established that a `stop` finish with non-empty text is NOT
 * automatically advice — something has to decide what the text is. m04570
 * narrowed HOW that decision may be made: structure and length, not punctuation
 * counting.
 *
 * The returned `kind` values mean:
 *   empty              nothing came back
 *   no-advice          the advisor said NO_ADVICE (a legitimate completion)
 *   too-long           text over the character ceiling; kept in the record, not
 *                      returned as advice
 *   advice             usable text
 *
 * Note that `sentences` is still reported. It is diagnostic, not a verdict.
 *
 * @returns {{kind: 'advice'|'no-advice'|'empty'|'too-long', reason?: string,
 *            sentences: number, chars: number, text: string}}
 */
export function parseAdvice(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return { kind: 'empty', reason: 'no-text', sentences: 0, chars: 0, text: '' };
  }
  if (text === ADVICE_PROTOCOL.noAdviceToken) {
    return { kind: 'no-advice', sentences: 0, chars: text.length, text };
  }
  // Reported, never used to reject (m04570).
  const sentences = text
    .split(/[.!?。！？]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
  if (text.length > ADVICE_PROTOCOL.maxChars) {
    return {
      kind: 'too-long',
      reason: 'over-character-ceiling',
      sentences,
      chars: text.length,
      text,
    };
  }
  return { kind: 'advice', sentences, chars: text.length, text };
}

/**
 * The local ledger: session -> consultation -> call -> response.
 *
 * m02026: "关键是本地能否可靠完成 会话 → 咨询 → 调用 → 响应 → 台账 ... 不需要把
 * DSH 会话身份发送给供应商." So this is the authoritative join, and it stays
 * local. Nothing here is derived from timing or from a mutable global pointer.
 */
/**
 * Classify what a usage reading actually is (m03309).
 *
 * The previous rule was: "non-zero, OR completed with content → provider".
 * m03309 is right that this does not follow. A provider can return text and
 * still omit usage, leaving the adapter's constructor zeros in place; and a
 * non-zero number can be an adapter estimate. Neither the value nor the success
 * of the call says where the numbers came from.
 *
 * So origin is not inferred at all. It is taken from an explicit claim when one
 * exists, and is `unknown` otherwise:
 *
 *   usageRaw          the numbers as received, zeros untouched, null if none
 *   usageOrigin       provider-reported | adapter-default | adapter-estimated | unknown
 *   usageCompleteness complete | partial | missing
 *
 * `TokenUsage` in `@deepseek-ai/dsh-llm` carries no provenance field, so for a
 * reading that came through the kernel the honest answer is `unknown` — unless
 * the transport states otherwise and says so. That is why this function takes
 * `originClaim` as an explicit argument rather than deriving it: a claim has to
 * be made by someone who knows, not reconstructed from a correlation.
 *
 * Completeness is separate from origin on purpose. "Four fields arrived, all
 * zero" and "nothing arrived" are different observations; both may have an
 * unknown origin.
 */
export function classifyUsage({ chunkSeen = false, usage = null, originClaim = null } = {}) {
  const claim =
    originClaim === 'provider-reported' ||
    originClaim === 'adapter-default' ||
    originClaim === 'adapter-estimated'
      ? originClaim
      : null;

  if (!chunkSeen || !usage || typeof usage !== 'object') {
    return {
      usageRaw: null,
      usageOrigin: claim ?? 'unknown',
      usageCompleteness: 'missing',
      usageOriginEvidence: claim ? 'transport-declared' : 'none',
    };
  }

  const present = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].filter(
    (key) => usage[key] !== undefined && usage[key] !== null,
  );
  // A count is "complete" only when both directions are present: a call costs
  // input and produces output, and a reading missing either cannot be billed
  // against. Anything else is partial, including an object with all-zero fields.
  const usageCompleteness =
    present.includes('inputTokens') && present.includes('outputTokens') ? 'complete' : 'partial';

  return {
    usageRaw: usage,
    usageOrigin: claim ?? 'unknown',
    usageCompleteness,
    usageOriginEvidence: claim ? 'transport-declared' : 'none',
  };
}

export function createLedger() {
  const entries = new Map();
  return {
    open(consultationId, fields) {
      entries.set(consultationId, {
        consultationId,
        openedAt: new Date().toISOString(),
        closed: false,
        ...fields,
      });
      return entries.get(consultationId);
    },
    get(consultationId) {
      return entries.get(consultationId) ?? null;
    },
    patch(consultationId, fields) {
      const entry = entries.get(consultationId);
      if (!entry) return null;
      Object.assign(entry, fields);
      return entry;
    },
    close(consultationId, fields) {
      const entry = entries.get(consultationId);
      if (!entry) return null;
      Object.assign(entry, fields, { closed: true, closedAt: new Date().toISOString() });
      return entry;
    },
    /**
     * Record an answer that arrived after the consultation was closed.
     * It must never reopen anything; it exists so that a late Allow is visible
     * in the record instead of silently vanishing.
     */
    lateAnswer(consultationId, answer) {
      const entry = entries.get(consultationId);
      if (!entry) return null;
      entry.lateAnswer = { at: new Date().toISOString(), answer };
      entry.lateAnswerIgnored = true;
      return entry;
    },
    all() {
      return [...entries.values()];
    },
    size() {
      return entries.size;
    },
  };
}

function textOf(result) {
  // `collectStream` returns the accumulated text directly. An earlier version of
  // this helper read `result.content` — a tool-result shape — so it always came
  // back empty and every successful consultation was recorded as "no text".
  return typeof (result && result.text) === 'string' ? result.text.trim() : '';
}

/**
 * Collect one `llm.stream` to completion.
 *
 * Written as a plain loop so that the terminal `finish` chunk is the only thing
 * that decides the outcome. A stream that ends without a finish is reported as
 * such rather than being mistaken for success.
 */
export async function collectStream(stream) {
  let text = '';
  let usage = null;
  // Whether a usage CHUNK arrived is a different observation from what it
  // carried: a chunk can arrive with `usage: null`. The record has to be able to
  // say "nothing arrived" without guessing it from a falsy value (m03309).
  let usageChunkSeen = false;
  let finish = null;
  const types = [];
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    types.push(chunk.type);
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.type === 'usage') {
      usage = chunk.usage;
      usageChunkSeen = true;
    } else if (chunk.type === 'finish') finish = chunk.reason;
  }
  return { text, usage, usageChunkSeen, finish, types };
}

/**
 * Create the advisor tool definition.
 *
 * @param options.rec            record sink (see lib/record.mjs)
 * @param options.llm            the LlmRuntime (`ctx.llm`)
 * @param options.getRootAgent   () => live root Agent | null
 * @param options.getUserQuestions () => UserQuestionService | null
 * @param options.provider       provider id for the consultation route
 * @param options.model          model id for the consultation route
 * @param options.markSystemPrompt  probe-only: put the consultation id in the
 *                                  system prompt so an outside observer can see
 *                                  it. OFF by default — see module header.
 * @param options.ledger         shared ledger (createLedger()); one per plugin
 * @param options.sessionId      optional session id recorded in the ledger only
 */
// A promise that resolves after `ms` without holding the process open.
const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

// Two independent abort sources (the caller's signal and our own deadline) have
// to become one signal, because the request carries exactly one.
function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list);
  }
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Wait for the stream, but never longer than the cancel allows.
 *
 * m02403: a cancel has to END the consultation, not annotate it once the adapter
 * finally returns. Racing the stream against the signal is the difference
 * between "we noticed the cancel" and "the cancel took effect" — the first one
 * still hangs forever when the adapter ignores the abort.
 *
 * @returns {{kind:'stream', result:any} | {kind:'aborted', graceExpired:boolean, waitedMs:number, lateResult:any}}
 */
async function raceStream(streamPromise, signal, graceMs) {
  const settled = streamPromise.then((result) => ({ kind: 'stream', result }));
  const waitForGrace = async (from) => {
    const grace = await Promise.race([settled, sleep(graceMs).then(() => ({ kind: 'grace-expired' }))]);
    return grace.kind === 'stream'
      ? { kind: 'aborted', graceExpired: false, waitedMs: Date.now() - from, lateResult: grace.result }
      : { kind: 'aborted', graceExpired: true, waitedMs: Date.now() - from, lateResult: null };
  };

  if (!signal) return settled;
  if (signal.aborted) return waitForGrace(Date.now());

  const aborted = new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true });
  });
  const first = await Promise.race([settled, aborted]);
  // The stream won the race, so the terminal state was determined before the
  // cancel arrived. A later cancel must not revise it.
  if (first.kind === 'stream') return first;
  return waitForGrace(Date.now());
}

/**
 * Classify one usage reading and write it onto a record (m03309).
 *
 * Shared by the normal path and the cancelled path, because a cancelled
 * consultation can already have received a usage chunk: recording `usage` but
 * leaving `usageCompleteness: 'missing'` next to it would make the record
 * contradict itself.
 *
 * `chunkSeen` is passed separately from `usage` on purpose. A stream can hand us
 * a usage object that the adapter constructed, and it can also deliver no chunk
 * at all; those are different observations and the caller is the only one who
 * knows which happened.
 */
function applyUsageReading(record, { chunkSeen, usage, originClaim }) {
  const usageClass = classifyUsage({ chunkSeen, usage, originClaim: originClaim ?? null });
  record.usageChunkSeen = Boolean(chunkSeen);
  record.usageRaw = usageClass.usageRaw;
  record.usageOrigin = usageClass.usageOrigin;
  record.usageCompleteness = usageClass.usageCompleteness;
  record.usageOriginEvidence = usageClass.usageOriginEvidence;
  // The single "can I bill against this?" flag: true only for a declared
  // provider-reported reading.
  record.usageKnown = record.usageOrigin === 'provider-reported';
}

export function createAdvisorTool(options) {
  const {
    rec,
    llm,
    getRootAgent,
    getUserQuestions,
    provider,
    model,
    authorizedScopes = DEFAULT_AUTHORIZED_SCOPES,
    consentWindowMs = 250,
    maxAdviceTokens = 400,
    markSystemPrompt = false,
    ledger = createLedger(),
    sessionId = null,
    // How long we keep waiting for the adapter AFTER a cancel. Past this we stop
    // waiting and settle; whatever the adapter returns later becomes its own
    // event (m02403).
    cancelGraceMs = 300,
    // Total budget for the consultation itself. 0 disables the internal deadline
    // and leaves the caller's signal as the only cancel source.
    consultDeadlineMs = 0,
    // What the transport is willing to say about where the usage numbers came
    // from (m03309). The kernel's `TokenUsage` carries no provenance field, so a
    // reading that arrives through it has no evidence attached and this stays
    // null — which the record then shows as `unknown`. Declaring a value here is
    // asserting knowledge; it is never inferred from the numbers or from the call
    // having succeeded.
    originClaim = null,
  } = options;

  let seq = 0;

  // m04570: which focus values is it honest to advertise?
  //
  // A focus that is not pre-authorized is not doomed — it goes to the human
  // consent seam and may be allowed. So if a consent seam exists, every focus is
  // potentially reachable and all of them may be offered.
  //
  // If there is no seam (headless, no `userQuestions`), an un-pre-authorized
  // focus can only ever come back refused. Offering it then is not a consent
  // check, it is a trap: on 2026-10-27 the tool offered `general`, the model used
  // it, and the consultation returned refused with zero characters — a wasted
  // call that looked like an advisor failure. In that case only pre-authorized
  // focuses are advertised.
  //
  // The audit itself never changes: an unauthorized focus arriving through any
  // other path is still refused. This only decides what the schema says.
  const consentSeamAvailable = (() => {
    try {
      const seam = typeof getUserQuestions === 'function' ? getUserQuestions() : null;
      return Boolean(seam && typeof seam.askTimed === 'function');
    } catch {
      return false;
    }
  })();
  const offeredFocus = consentSeamAvailable
    ? [...ADVISOR_FOCUS]
    : ADVISOR_FOCUS.filter((focus) => authorizedScopes.includes(focus));

  // An enum of zero values is not a valid schema, and it would remove the only
  // parameter that carries meaning. If nothing is pre-authorized and no seam
  // exists, the caller has configured a tool that can never succeed; keep the
  // schema valid and let the refusal be explicit at execute time.
  const advertisedFocus = offeredFocus.length > 0 ? offeredFocus : [...ADVISOR_FOCUS];

  return {
    name: ADVISOR_TOOL_NAME,
    description:
      'Ask a second model for an opinion on one decision. Use when a decision is expensive to reverse, ' +
      'or when you are unsure you have considered what you might be missing. ' +
      'Returns advice, or a refusal when consent was not granted.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The single decision to review. State what you are about to do, and why.',
        },
        focus: {
          type: 'string',
          // m04570: expose only what this run is actually authorized to send.
          // Advertising a focus that consent will always refuse is not a consent
          // check, it is a trap: on 2026-10-27 the tool offered `general`, the
          // model used it, and the consultation came back refused with zero
          // characters. The audit itself stays in place — an unauthorized focus
          // that arrives another way is still refused; it is simply no longer
          // advertised.
          enum: advertisedFocus,
          description: 'What kind of decision this is. Decides whether consent is already covered.',
        },
        deadlineMs: {
          type: 'integer',
          description:
            'Optional total budget for this consultation. When it runs out the consultation ends as ' +
            'timed-out and no advice is delivered, even if the advisor answers later.',
        },
      },
      required: ['question'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            description: 'advised | no_advice | refused_no_consent | failed',
          },
          consultationId: { type: 'string', description: 'Identity of this consultation.' },
          advice: { type: 'string', description: 'The advisor text, or an explanation of the refusal.' },
        },
        required: ['outcome', 'consultationId', 'advice'],
      },
      render(_args, value) {
        const outcome = value && value.outcome;
        const advice = value && typeof value.advice === 'string' ? value.advice : '';
        const id = value && value.consultationId;
        if (outcome === 'refused_no_consent') {
          return [{ type: 'text', text: `Advisor not consulted (no consent): ${advice}\n[${id}]` }];
        }
        if (outcome === 'failed') {
          return [{ type: 'text', text: `Advisor consultation failed: ${advice}\n[${id}]` }];
        }
        return [{ type: 'text', text: `${advice}\n[${id}]` }];
      },
    },

    async execute(args, exec) {
      seq += 1;
      const focus = ADVISOR_FOCUS.includes(args && args.focus) ? args.focus : 'general';
      const question = typeof (args && args.question) === 'string' ? args.question : '';
      // Attribution is minted here, at the entry point, from the tool call the
      // host handed us. Nothing downstream guesses who this request belongs to.
      const consultationId = `consult-${exec.callId}-${seq}`;

      const record = {
        consultationId,
        callId: exec.callId,
        focus,
        questionChars: question.length,
        authorizedBy: null,
        consent: null,
        consentAsked: false,
        consentOutcome: null,
        requestIssued: false,
        // m02196: a record written before the terminal state exists must not
        // pre-declare one. `status` is 'pending' until settle() runs.
        status: 'pending',
        recordType: 'progress',
        outcome: null,
        // Raw numbers as received, zeros untouched (m03309). `usage` is kept as
        // the same value for readers that predate the split; `usageRaw` is the
        // explicit name.
        usage: null,
        usageRaw: null,
        // Where those numbers came from: provider-reported | adapter-default |
        // adapter-estimated | unknown. Never inferred.
        usageOrigin: 'unknown',
        // complete | partial | missing — how much of the reading arrived, which
        // is a different question from where it came from.
        usageCompleteness: 'missing',
        usageOriginEvidence: 'none',
        usageChunkSeen: false,
        // "Can a caller bill against this?" — true only for a declared
        // provider-reported reading, and false for an unattributed zero.
        usageKnown: false,
        finishKind: null,
        adviceChars: 0,
        parseResult: null,
      };

      ledger.open(consultationId, {
        callId: exec.callId,
        sessionId,
        focus,
        provider,
        model,
        consent: null,
        requestIssued: false,
        response: null,
        usage: null,
      });

      // Set when the consultation's own budget runs out. Kept separate from the
      // caller's signal because "the caller cancelled" and "the budget ran out"
      // are different reasons and must not be recorded under one name (m02403).
      let deadlineFired = false;
      let deadlineTimer = null;
      let deadlineController = null;
      // One consultation, one terminal state. A second settle() is a bug in the
      // caller's flow, not something to silently paper over.
      let settled = false;

      // m02196: the tool return value and the completion record must come from
      // the SAME terminal object. This is that object. It is written once; a
      // later callback can only observe it, never revise it.
      const settle = (outcome, terminal) => {
        if (settled) {
          throw new Error(`consultation ${consultationId} settled twice (second: ${outcome})`);
        }
        settled = true;
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        const { caseId, verdict, limitations, extra } = terminal || {};
        record.outcome = outcome;
        record.status = 'terminal';
        record.recordType = 'result';
        record.terminalKind = terminal && terminal.terminalKind ? terminal.terminalKind : outcome;
        ledger.close(consultationId, {
          outcome,
          status: 'terminal',
          terminalKind: record.terminalKind,
          consent: record.consentKind ?? record.consentOutcome ?? 'config-scope',
          requestIssued: record.requestIssued,
          finishKind: record.finishKind,
          parseResult: record.parseResult,
          usage: record.usage,
          // Provenance travels with the numbers (m03003, revised by m03309). A
          // caller reading only `usage` sees zeros; the four fields below say
          // whether those zeros were measured, constructed, or never arrived.
          // Origin is taken from an explicit claim only, so a reading that came
          // through the kernel — which carries no provenance — is `unknown`.
          usageRaw: record.usageRaw ?? null,
          usageOrigin: record.usageOrigin ?? 'unknown',
          usageCompleteness: record.usageCompleteness ?? 'missing',
          usageOriginEvidence: record.usageOriginEvidence ?? 'none',
          usageChunkSeen: Boolean(record.usageChunkSeen),
          usageKnown: Boolean(record.usageKnown),
          adviceChars: record.adviceChars,
          // m02403: `textArrivedLate` used to live here. It does not belong in a
          // closed completion record — the completion says cancelled/timed-out,
          // and a late answer becomes its own event linked by consultationId.
          terminalReason: record.terminalReason ?? null,
          waitEndedAs: record.waitEndedAs ?? null,
          error: record.error ?? null,
          ...extra,
        });
        const value = { outcome, consultationId, advice: record.adviceText ?? '' };
        rec({
          caseId: caseId || 'P2/consultation-result',
          // A completion record describes what the consultation did. It is not
          // an assertion that the probe worked, so it is tagged and counted
          // separately from pass/fail/unknown.
          recordType: 'result',
          consultationId,
          expectation:
            'a consultation reaches exactly one terminal state, and the record agrees with the returned value',
          observed: { ...record, returnedValue: value },
          outcome: verdict || 'pass',
          limitations,
        });
        return value;
      };

      // ---- 1. consent -----------------------------------------------------
      // The taxonomy below is the whole point of this block. m02026: pending is
      // NOT consent, and a timeout, a cancellation and an unanswered question
      // are three different things that all fail closed.
      if (authorizedScopes.includes(focus)) {
        record.authorizedBy = 'config-scope';
        record.consent = 'config-scope';
        ledger.patch(consultationId, { consent: { kind: 'config-scope' } });
      } else {
        const userQuestions = getUserQuestions();
        const agent = exec.agent ?? (typeof getRootAgent === 'function' ? getRootAgent() : null);
        if (!userQuestions || typeof userQuestions.askTimed !== 'function') {
          record.consentOutcome = 'no-service';
          record.adviceText = 'the authorization seam is unavailable, so nothing was sent';
          return settle('refused_no_consent', {
            caseId: 'P2/consent-unavailable',
            verdict: 'blocked',
            terminalKind: 'no-service',
            limitations:
              'userQuestions did not resolve, so consent could not be requested; no request was issued',
            extra: { consent: { kind: 'no-service' } },
          });
        }
        if (!agent) {
          record.consentOutcome = 'no-live-root-agent';
          record.adviceText = 'no live root agent to ask, so nothing was sent';
          return settle('refused_no_consent', {
            caseId: 'P2/consent-no-agent',
            verdict: 'blocked',
            terminalKind: 'no-live-root-agent',
            limitations:
              'ask() is only valid for the exact live runtime root; without one no question can be addressed',
            extra: { consent: { kind: 'no-live-root-agent' } },
          });
        }

        // A signal already aborted means the caller gave up before we asked.
        // Asking anyway would put a dialog in front of a human for a decision
        // that can no longer be acted on.
        if (exec.signal && exec.signal.aborted) {
          record.outcome = 'refused_no_consent';
          record.consentOutcome = 'cancelled-before-ask';
          ledger.close(consultationId, {
            consent: { kind: 'cancelled-before-ask' },
            outcome: 'refused_no_consent',
          });
          return {
            outcome: 'refused_no_consent',
            consultationId,
            advice: 'the call was cancelled before consent could be requested',
          };
        }

        record.consentAsked = true;
        let answer = null;
        let consentError = null;
        try {
          answer = await userQuestions.askTimed(
            {
              questions: [
                {
                  id: 'advisor-consent',
                  question: `Allow one advisor consultation about this ${focus}?`,
                  header: 'Advisor',
                  detail: question.slice(0, 400),
                  options: [{ label: 'Allow once' }, { label: 'Deny' }],
                },
              ],
              agent,
              signal: exec.signal,
              wait: { callId: exec.callId, timed: true },
            },
            exec.callId,
            consentWindowMs,
          );
        } catch (err) {
          consentError = { name: err && err.name, code: err && err.code, message: String((err && err.message) || err) };
        }

        const pending = Boolean(answer && answer.pending === true);
        const items = answer && Array.isArray(answer.answers) ? answer.answers : [];
        const selected = items.flatMap((item) => (Array.isArray(item.selected) ? item.selected : []));
        const allowed = !pending && !consentError && selected.includes('Allow once');

        // Five terminal kinds, five different meanings. Only `allowed` proceeds.
        const consentKind = consentError
          ? exec.signal && exec.signal.aborted
            ? 'cancelled'
            : 'error'
          : pending
            ? 'pending'
            : allowed
              ? 'allowed'
              : 'denied';

        record.consentOutcome = consentError ? `error:${consentError.message}` : pending ? 'pending' : allowed ? 'allowed' : 'denied';
        record.consent = consentKind;
        record.consentKind = consentKind;
        record.consentError = consentError;
        record.consentSelected = selected;

        ledger.patch(consultationId, {
          consent: {
            kind: consentKind,
            asked: true,
            selected,
            windowMs: consentWindowMs,
            error: consentError,
          },
        });

        if (!allowed) {
          record.adviceText =
            consentKind === 'pending'
              ? 'nobody answered the consent question in time'
              : consentKind === 'cancelled'
                ? 'the call was cancelled while waiting for consent'
                : consentKind === 'error'
                  ? `the consent question failed: ${consentError.message}`
                  : 'the human declined';
          return settle('refused_no_consent', {
            caseId: 'P2/consent-refused',
            verdict: consentKind === 'error' ? 'unknown' : 'pass',
            terminalKind: `consent-${consentKind}`,
            limitations:
              consentKind === 'pending'
                ? 'a pending answer is not consent; this host had no client able to answer'
                : consentKind === 'cancelled'
                  ? 'the call was cancelled while the question was open'
                  : consentKind === 'error'
                    ? 'the consent seam failed; treated as no consent'
                    : 'the human declined',
          });
        }
        record.authorizedBy = 'live-consent';
      }

      // ---- 2. the consultation -------------------------------------------
      // One exit path per terminal kind, and every one of them closes the
      // ledger with the real outcome. Closing before the outcome is known would
      // make the ledger assert things the code has not decided yet.
      if (exec.signal && exec.signal.aborted) {
        record.finishKind = 'aborted-before-request';
        record.adviceText = 'the call was cancelled before consulting';
        return settle('failed', {
          caseId: 'P2/consultation-result',
          verdict: 'pass',
          terminalKind: 'aborted-before-request',
          limitations: 'the tool call was already cancelled, so no consultation was issued',
        });
      }

      // The consultation's budget starts here, not at entry: the time spent
      // asking for consent is the human's time, not the advisor's.
      const requestedBudget = Number.isFinite(args && args.deadlineMs) ? args.deadlineMs : 0;
      const budget = Math.min(
        requestedBudget > 0 ? requestedBudget : Infinity,
        consultDeadlineMs > 0 ? consultDeadlineMs : Infinity,
      );
      if (Number.isFinite(budget) && budget > 0) {
        deadlineController = new AbortController();
        deadlineTimer = setTimeout(() => {
          deadlineFired = true;
          deadlineController.abort();
        }, budget);
        if (deadlineTimer && typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
        record.deadlineMs = budget;
      }
      const effectiveSignal = combineSignals([
        exec.signal,
        deadlineController ? deadlineController.signal : null,
      ]);

      const request = {
        provider,
        model,
        // The marker is OFF unless the probe explicitly asked for it. A per-call
        // id in the system prompt would change the request on every call, which
        // is the opposite of what a cache-friendly design wants.
        system: buildAdvisorSystemPrompt(focus, markSystemPrompt ? consultationId : null),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: question || '(no question supplied)' }],
          },
        ],
        maxTokens: maxAdviceTokens,
        signal: effectiveSignal,
      };

      record.requestIssued = true;
      ledger.patch(consultationId, {
        requestIssued: true,
        requestShape: {
          provider: request.provider,
          model: request.model,
          systemChars: request.system.length,
          systemHasMarker: markSystemPrompt,
          messageCount: request.messages.length,
          maxTokens: request.maxTokens,
          hasTools: false,
          deadlineMs: record.deadlineMs ?? null,
        },
      });

      // m02403 boundary 1: the wait is bounded. Racing the stream against the
      // signal is what makes a cancel actually END the consultation; awaiting
      // collectStream() first would hang forever on an adapter that ignores the
      // abort, and a 400 ms fixture would still look perfectly fine.
      const streamPromise = collectStream(llm.stream(request));
      // If we stop waiting, a later rejection must not surface as unhandled.
      streamPromise.catch(() => {});

      let race = null;
      let error = null;
      try {
        race = await raceStream(streamPromise, effectiveSignal, cancelGraceMs);
      } catch (err) {
        error = { name: err && err.name, code: err && err.code, message: String((err && err.message) || err) };
      }

      if (race && race.kind === 'aborted') {
        const late = race.lateResult;
        // Manual cancel and an exhausted budget are different reasons; sharing
        // an AbortSignal does not make them the same event (m02403).
        record.terminalReason = deadlineFired ? 'deadline-exhausted' : 'cancelled-by-caller';
        record.waitEndedAs = race.graceExpired ? 'grace-expired' : 'stream-finished-within-grace';
        record.waitMsAfterCancel = race.waitedMs;
        record.finishKind = late && late.finish ? late.finish.kind : null;
        record.usage = late && late.usage ? late.usage : null;
        // A cancelled call can still have received a usage chunk before the
        // cancel arrived. Whatever it reported is classified by the same rule as
        // a completed call — the cancel does not make the numbers less real, and
        // it also does not make them the provider's.
        applyUsageReading(record, {
          chunkSeen: Boolean(late && late.usageChunkSeen),
          usage: record.usage,
          originClaim,
        });
        record.adviceChars = late && typeof late.text === 'string' ? late.text.length : 0;
        record.adviceText =
          record.terminalReason === 'deadline-exhausted'
            ? 'the consultation ran out of time; nothing it says afterwards is delivered'
            : 'the consultation was cancelled; nothing it says afterwards is delivered';

        if (race.graceExpired) {
          // The adapter is still running. Whatever it returns from now on is a
          // NEW fact about a closed consultation: it becomes its own event and
          // must not edit the completion record (m02403 boundary 2).
          const closedAt = Date.now();
          const reportLate = (observed) => {
            const closed = ledger.get(consultationId) || {};
            rec({
              caseId: 'P2/consultation-late-return',
              consultationId,
              recordType: 'event',
              expectation:
                'a response arriving after the consultation closed is recorded as its own event and does not revise the closed record',
              observed: {
                consultationId,
                arrivedAfterMs: Date.now() - closedAt,
                discarded: true,
                closedOutcome: closed.outcome ?? null,
                closedTerminalKind: closed.terminalKind ?? null,
                closedTerminalReason: closed.terminalReason ?? null,
                closedWaitEndedAs: closed.waitEndedAs ?? null,
                ...observed,
              },
            });
          };
          let lateReported = false;
          const reportOnce = (observed) => {
            if (lateReported) return;
            lateReported = true;
            reportLate(observed);
          };
          streamPromise.then(
            (arrived) =>
              reportOnce({
                arrivedAs: 'text',
                adviceChars: arrived && typeof arrived.text === 'string' ? arrived.text.length : 0,
                finishKind: arrived && arrived.finish ? arrived.finish.kind : null,
              }),
            (err2) => reportOnce({ arrivedAs: 'error', message: String((err2 && err2.message) || err2) }),
          );
          // The host is not obliged to settle a consumer stream after the abort.
          // If it never does, that is itself the observation, and it is recorded
          // rather than left as a silently missing event.
          const lateWatchdog = setTimeout(() => {
            reportOnce({
              arrivedAs: 'not-settled-within-observation-window',
              observationWindowMs: Math.max(cancelGraceMs, 0) + 1500,
              note: 'the adapter may still have produced an answer; the consumer stream never settled after the abort',
            });
          }, Math.max(cancelGraceMs, 0) + 1500);
          if (lateWatchdog && typeof lateWatchdog.unref === 'function') lateWatchdog.unref();
        }

        const honouredAbort = Boolean(late && late.finish && late.finish.kind === 'aborted');
        return settle('failed', {
          caseId: 'P2/consultation-result',
          verdict: 'pass',
          terminalKind: honouredAbort ? 'aborted' : 'aborted-after-cancel',
          limitations:
            'the terminal state is decided by the cancel or the budget, never by what the adapter eventually returns',
        });
      }

      const result = race && race.kind === 'stream' ? race.result : null;

      record.finishKind = result && result.finish ? result.finish.kind : null;
      record.usage = result && result.usage ? result.usage : null;
      record.adviceChars = result && typeof result.text === 'string' ? result.text.length : 0;

      // m03309: origin is never inferred from the value or from success.
      //
      // The previous version treated "completed with content" as proof the
      // provider reported the numbers. It is not: a provider can answer and omit
      // usage, and the adapter's constructor zeros then survive; a non-zero
      // number can be an adapter estimate. `TokenUsage` has no provenance field,
      // so what arrives through the kernel is `unknown` by construction.
      //
      // A claim is only recorded when something that actually knows makes one —
      // the transport, not this code. `originClaim` is that channel, and it stays
      // null unless a caller sets it.
      applyUsageReading(record, {
        chunkSeen: Boolean(result && result.usageChunkSeen),
        usage: record.usage,
        originClaim,
      });

      if (error || !result || !result.finish) {
        record.error = error;
        record.adviceText = error ? error.message : 'the advisor stream ended without a finish';
        return settle('failed', {
          caseId: 'P2/consultation-result',
          verdict: 'pass',
          terminalKind: 'no-finish',
          limitations: 'a consultation that never reaches a finish cannot support any advice claim',
        });
      }

      if (result.finish.kind === 'aborted') {
        record.adviceText = 'the consultation was cancelled';
        return settle('failed', {
          caseId: 'P2/consultation-result',
          verdict: 'pass',
          terminalKind: 'aborted',
          limitations: 'aborted is a legitimate terminal state, not an advisor opinion',
        });
      }

      if (result.finish.kind !== 'stop') {
        record.adviceText = `the advisor stopped with ${result.finish.kind}`;
        return settle('failed', {
          caseId: 'P2/consultation-result',
          verdict: 'pass',
          terminalKind: 'non-stop',
          limitations: `finish kind ${result.finish.kind} is not a usable opinion`,
        });
      }

      // A `stop` finish only says the model stopped talking. What the text IS
      // has to be decided by the protocol parser, not by the finish reason.
      const parsed = parseAdvice(textOf(result));
      record.parseResult = {
        kind: parsed.kind,
        reason: parsed.reason ?? null,
        sentences: parsed.sentences,
        chars: parsed.chars,
      };
      record.adviceChars = parsed.chars;

      if (parsed.kind === 'empty') {
        record.adviceText = 'the advisor returned no text';
        return settle('failed', {
          caseId: 'P2/consultation-result',
          verdict: 'pass',
          terminalKind: 'empty',
          limitations: 'a stop finish with no text is not advice',
        });
      }

      // m04570: `too-long` is the only remaining structural refusal. It says the
      // response is not a usable opinion, not that it was impolite. Punctuation
      // counting no longer rejects anything — see parseAdvice.
      if (parsed.kind === 'too-long') {
        record.adviceText = parsed.text;
        return settle('failed', {
          caseId: 'P2/consultation-result',
          verdict: 'pass',
          terminalKind: 'too-long',
          limitations: `the response exceeded the character ceiling (${parsed.reason}); it is kept in the record but not returned as advice`,
        });
      }

      record.adviceText = parsed.text;
      return settle(parsed.kind === 'no-advice' ? 'no_advice' : 'advised', {
        caseId: 'P2/consultation-result',
        verdict: 'pass',
        terminalKind: parsed.kind,
        limitations:
          'mock adapter only; a real provider adds transport, auth, retry and billing behaviour that this cannot show',
      });
    },
  };
}
