/**
 * dsh-advisor — let a working session ask a second model for a second opinion.
 *
 * The plugin registers `advisor_consult` and, with a known profile home,
 * `advisor_work_report` for results of explicitly assigned work. Nothing is sent to any provider until
 * the main model calls that tool.
 *
 * What the tool is for: a decision that is expensive to reverse, or a moment
 * where the agent suspects it has not considered something. It is not a gate,
 * not a required step, and not a reviewer of every change — an advisor that
 * fires on every edit is a tax, not a check.
 *
 * Design decisions that are not obvious, and why:
 *
 * 1. The tool is registered, never scheduled. There is no automatic
 *    consultation, no follow-up round, no retry. One tool call is one
 *    plugin-initiated model call, which is what makes the cost attributable.
 *
 * 2. The plugin never terminates the host process and never leaves a timer
 *    behind. Process lifetime belongs to the host; a plugin that exits on its
 *    own makes every session unusable, and a leaked timer keeps a headless run
 *    alive after the work is done.
 *
 * 3. Consent is a hard gate, not a warning. A focus the run was not
 *    pre-authorized for goes to the host's `userQuestions` seam; if that seam
 *    does not exist (headless), the consultation is refused and no request is
 *    issued. The schema therefore only advertises focuses that are actually
 *    reachable — offering one that would always be refused is a trap, not a
 *    consent check.
 *
 * 4. Usage provenance is reported as `unknown` and never inferred (m03309).
 *    The kernel's `TokenUsage` carries no provenance field, so a reading that
 *    arrives through it has no evidence attached. A zero that was never
 *    measured is not a measurement.
 *
 * 5. Records are append-only JSONL and contain no advice text. They answer
 *    "why was this consultation made, what came back, and what did it cost" —
 *    not "what did the second model say", which belongs in the session.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ADVISOR_FOCUS,
  ADVISOR_TOOL_NAME,
  DEFAULT_AUTHORIZED_SCOPES,
  createAdvisorTool,
  createLedger,
} from './advisor.js'
import { createHost, mountHostChannel, resolveHome } from './host.js'
import { loadSettings, effectiveMode, resolveConsultTarget } from './settings.js'
import { openHistory } from './history.js'
import { createWorkReportTool } from './workflow.js'

export const name = 'dsh-advisor'

/**
 * Only `llm` is a hard dependency. `tools` arrives through `ctx.inject`
 * because it may not exist yet when this plugin is applied.
 */
export const inject = ['llm']

/** Absolute path of this entry point. Used to keep records out of the cwd. */
export const DEFAULT_LIVE_CONFIG = {
  /**
   * Empty means "the model this session is already using". A plugin that
   * silently picks its own provider would send a session's data somewhere the
   * user never chose.
   */
  provider: null,
  model: null,
  /** Output cap handed to the provider. It is not a guarantee about the bill. */
  maxAdviceTokens: 1000,
  authorizedScopes: DEFAULT_AUTHORIZED_SCOPES,
  consentWindowMs: 60000,
  cancelGraceMs: 300,
  /**
   * Total budget for one consultation. When it runs out the consultation ends
   * as timed-out and no advice is delivered, even if the advisor answers later.
   */
  consultDeadlineMs: 60000,
  /**
   * Hard ceiling on plugin-initiated model calls for this run. Checked BEFORE
   * the request is built, so an over-limit call costs nothing.
   */
  maxConsultationsPerRun: 8,
  /**
   * Whether the advice is shown to the calling model. `false` performs the call
   * and discards the text — useful only for measuring cost without influence.
   */
  injectAdvice: true,
  /**
   * Where per-call records land. `null` disables recording; a relative path is
   * resolved against the plugin's own directory, never the user's cwd, so a
   * working session does not accumulate JSONL in whatever it happens to be
   * editing.
   */
  outputDir: null,
  /** Text appended to the run id so two runs in the same millisecond differ. */
  runId: null,
}

const BUDGET_EXHAUSTED_OUTCOME = 'budget_exhausted'

/**
 * Resolve the model to consult.
 *
 * Returning `null` for provider/model is deliberate: the caller then asks the
 * host what this session is already using, and a missing answer is reported as
 * a configuration error instead of silently falling back to a provider the user
 * never picked.
 */
export function resolveTarget(config, defaults) {
  const provider = config.provider ?? defaults?.provider ?? null
  const model = config.model ?? defaults?.model ?? null
  return { provider, model }
}

function resolveConfig(config, defaults = null) {
  const merged = { ...DEFAULT_LIVE_CONFIG, ...(config || {}) }
  if (!Array.isArray(merged.authorizedScopes) || merged.authorizedScopes.length === 0) {
    merged.authorizedScopes = [...DEFAULT_AUTHORIZED_SCOPES]
  }
  for (const scope of merged.authorizedScopes) {
    if (!ADVISOR_FOCUS.includes(scope)) {
      throw new Error(
        `dsh-advisor: unknown authorized scope ${JSON.stringify(scope)}; known: ${ADVISOR_FOCUS.join(', ')}`,
      )
    }
  }
  if (!Number.isInteger(merged.maxConsultationsPerRun) || merged.maxConsultationsPerRun < 0) {
    throw new Error(
      `dsh-advisor: maxConsultationsPerRun must be a non-negative integer, got ${JSON.stringify(merged.maxConsultationsPerRun)}`,
    )
  }
  if (!Number.isInteger(merged.maxAdviceTokens) || merged.maxAdviceTokens <= 0) {
    throw new Error(
      `dsh-advisor: maxAdviceTokens must be a positive integer, got ${JSON.stringify(merged.maxAdviceTokens)}`,
    )
  }
  const target = resolveTarget(merged, defaults)
  merged.provider = target.provider
  merged.model = target.model
  return merged
}

/**
 * Append-only JSONL sink. Synchronous on purpose: an async writer needs a
 * pending promise or a timer, and "no leftover handles after dispose" is easier
 * to guarantee without one.
 */
function createJsonlSink(directory, filename) {
  if (!directory) return null
  const target = join(directory, filename)
  mkdirSync(directory, { recursive: true })
  return {
    path: target,
    write(record) {
      appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8')
    },
  }
}

/**
 * Build the advisor tool without touching any host service.
 *
 * Everything the tool needs is injected, which is what makes the offline test
 * suite possible with a fake `llm` and a fake `tools`.
 */
export function createAdvisor(options = {}) {
  const {
    llm,
    config = {},
    defaults = null,
    getRootAgent = null,
    getUserQuestions = null,
    unloadSignal = null,
    ledger = null,
    // Where to read the person's preferences from. `home` is the profile home
    // that holds `dsh-advisor/settings.json`; `readSettings` is an injection seam
    // so tests can supply a settings object without touching the disk. Both are
    // optional: without them the tool behaves exactly as it did before the
    // switch existed, which is what a mount that never mounted the host half
    // should get.
    home = null,
    readSettings = null,
    getSessionId = null,
    getDefaultModel = null,
  } = options

  const cfg = resolveConfig(config, defaults)
  const runLedger = ledger ?? createLedger()

  const runId = cfg.runId ?? new Date().toISOString().replace(/[:.]/gu, '-')
  // A relative outputDir is anchored to this package, not to process.cwd(): a
  // session may be started anywhere, and records appearing in the directory
  // being edited is a surprise nobody asked for.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outputRoot = cfg.outputDir ? resolve(packageRoot, cfg.outputDir) : null
  const outputDir = outputRoot ? join(outputRoot, runId) : null
  const callsSink = createJsonlSink(outputDir, 'advisor-calls.jsonl')
  const eventsSink = createJsonlSink(outputDir, 'advisor-events.jsonl')

  const state = {
    runId,
    outputDir,
    provider: cfg.provider,
    model: cfg.model,
    consultations: 0,
    maxConsultationsPerRun: cfg.maxConsultationsPerRun,
    /** Set when the budget gate refused a call; useful for the run summary. */
    refusedForBudget: 0,
    /** Consultations that never reached the provider, by reason. */
    refusedTotal: 0,
    /** Every consultation id this run opened, in order. */
    consultationIds: [],
  }

  const rec = (record) => {
    if (eventsSink) eventsSink.write({ at: new Date().toISOString(), ...record })
  }

  /**
   * Should a model-initiated consultation be allowed to run at all?
   *
   * The person's master switch and usage mode are not advice — they are the two
   * settings that decide whether this plugin may spend money on their behalf.
   * Both used to be enforced only on the composer path, which meant the model
   * could keep consulting after the switch was off. This closes that.
   *
   * What each mode means for a model-initiated call:
   *
   *   off        — refuse, whatever the mode says.
   *   manual     — refuse. The label is "only when I ask"; a tool call is not a
   *                person asking.
   *   confirm    — pass a trusted per-call policy that forces live consent,
   *                including focuses preauthorized by legacy configuration.
   *   auto       — the current preference or an unexpired session grant
   *                authorizes every supported focus without another prompt.
   *
   * A settings file that cannot be read yields `null` (allowed), because a
   * broken file must not silently disable a capability; the failure surfaces
   * where it can be acted on, in the settings page.
   */
  function gateForTool(exec) {
    let settings = null
    try {
      if (typeof readSettings === 'function') {
        settings = readSettings()
      } else if (typeof home === 'string' && home !== '') {
        settings = loadSettings(home)
      }
    } catch {
      return null
    }
    if (!settings || typeof settings !== 'object') return null

    const enabled = settings.enabled !== false
    if (!enabled) {
      return {
        reason: 'disabled',
        enabled: false,
        mode: settings.mode,
        advice:
          'The advisor is switched off in settings, so nothing was sent. Turn it back on in Settings → Advisor if the second opinion is wanted.',
      }
    }

    // Which session this call belongs to decides whether a grant applies. The
    // host does not hand a tool execution its session id, so the mount supplies
    // one; when neither is available the global mode is the only honest input.
    let sessionId = null
    try {
      if (typeof getSessionId === 'function') {
        sessionId = getSessionId(exec) || null
      } else {
        // The host does not pass a session id to a tool execution, but the agent
        // that issued the call carries one. Reading it here means a per-session
        // grant works without the mount having to know about that shape.
        const agent = exec && exec.agent
        sessionId = agent && agent.session && typeof agent.session.id === 'string' ? agent.session.id : null
      }
    } catch {
      sessionId = null
    }
    const mode = effectiveMode(settings, sessionId)

    if (mode === 'manual') {
      return {
        reason: 'manual-mode',
        enabled: true,
        mode,
        advice:
          'The advisor is set to "only when I ask", so a model-initiated consultation was not sent. Ask for it explicitly, or change the mode in Settings → Advisor.',
      }
    }

    return { mode, enabled: true, settings, sessionId }
  }

  const base = createAdvisorTool({
    rec,
    llm,
    provider: cfg.provider,
    model: cfg.model,
    getRootAgent,
    getUserQuestions,
    authorizedScopes: cfg.authorizedScopes,
    consentWindowMs: cfg.consentWindowMs,
    maxAdviceTokens: cfg.maxAdviceTokens,
    cancelGraceMs: cfg.cancelGraceMs,
    consultDeadlineMs: cfg.consultDeadlineMs,
    ledger: runLedger,
    // No provenance claim is made for a live reading: the kernel carries no
    // provenance field, so anything the host reports stays `unknown` (m03309).
    originClaim: null,
  })

  /**
   * The tool result the main model sees. `advisor.js` returns exactly
   * `{ outcome, consultationId, advice }`; the extra flags are read back from
   * the ledger so that a cancellation is never reported as a timeout and vice
   * versa, and so a withheld or over-budget result cannot be mistaken for a
   * real consultation.
   */
  const toToolResult = (value, terminalReason, truncated = false) => {
    const cancelled = terminalReason === 'cancelled-by-caller'
    const timedOut = terminalReason === 'deadline-exhausted'
    const withheld = cfg.injectAdvice === false
    return {
      outcome: value.outcome,
      consultationId: value.consultationId,
      advice: withheld ? '' : value.advice,
      cancelled,
      timedOut,
      adviceWithheld: withheld,
      // Delivered, but cut off where the output budget ran out. Reported beside
      // the text rather than instead of it: what a half-finished opinion is
      // worth is the caller's call, and it cannot make that call about text it
      // was never shown.
      truncated: Boolean(truncated),
      budgetRemaining: Math.max(0, cfg.maxConsultationsPerRun - state.consultations),
    }
  }

  function targetFor(gate) {
    if (!gate?.settings?.target) return { provider: cfg.provider, model: cfg.model }
    const selection = typeof getDefaultModel === 'function' ? getDefaultModel() : defaults ?? cfg
    return resolveConsultTarget(gate.settings, selection)
  }

  const tool = {
    ...base,
    // A settings-managed mount can change modes without being remounted.
    // Advertise all focuses; execution still enforces its live consent policy.
    ...((home || readSettings) ? {
      parameters: { ...base.parameters, properties: { ...base.parameters.properties,
        focus: { ...base.parameters.properties.focus, enum: [...ADVISOR_FOCUS] },
      } },
    } : {}),
    async execute(args, exec) {
      // The person's preferences gate the tool too, not only the composer.
      //
      // This was a real hole: the master switch and the "only when I ask" mode
      // lived in settings.json and were read exclusively by the host channel, so
      // a model-initiated `advisor_consult` ignored both. A person who switched
      // the advisor off, or chose "never start on its own", still had the model
      // spending their money on a second provider. Reading the same file here is
      // what makes the switch mean what its label says.
      //
      // `gateForTool` returns the current mode, or a refusal reason.
      // A legacy mount without settings returns null. It never throws: a settings file that cannot be read
      // must not turn a consultation into a crash, so it falls back to "allowed"
      // and the host's own defaults, which is the pre-switch behaviour.
      const gate = typeof gateForTool === 'function' ? gateForTool(exec) : null
      if (gate?.reason) {
        state.refusedTotal += 1
        rec({
          caseId: 'LIVE/refused-by-preference',
          expectation: 'a preference the person set stops a model-initiated consultation before any provider call',
          observed: { reason: gate.reason, mode: gate.mode, enabled: gate.enabled },
          outcome: 'pass',
        })
        return {
          outcome: 'refused_no_consent',
          consultationId: `refused-${gate.reason}-${state.refusedTotal}`,
          advice: gate.advice,
          cancelled: false,
          timedOut: false,
          adviceWithheld: false,
          truncated: false,
          budgetRemaining: Math.max(0, cfg.maxConsultationsPerRun - state.consultations),
        }
      }

      // Configuration errors are reported before any budget accounting: a tool
      // that cannot call anyone should say so on the first use, not silently
      // refuse every call with a misleading reason.
      const callTarget = targetFor(gate)
      if (!callTarget.provider || !callTarget.model) {
        return {
          outcome: 'failed',
          consultationId: `unconfigured-${state.consultations}`,
          advice:
            'dsh-advisor is not configured: set provider and model, or mount it in a session whose default model is known.',
          cancelled: false,
          timedOut: false,
          adviceWithheld: false,
          // Every exit carries the same keys. A caller that reads `.truncated`
          // should not have to tell "false" apart from "this path forgot it".
          truncated: false,
          budgetRemaining: Math.max(0, cfg.maxConsultationsPerRun - state.consultations),
        }
      }

      // Budget gate first. A refusal must not build a request, open a ledger
      // entry, or touch the provider — the whole point is that it is free.
      const spending = home && gate?.sessionId ? openHistory(home, gate.sessionId, {
        limit: gate.settings?.advanced?.historyLimit,
      }) : null
      const sessionCeiling = gate?.settings?.advanced?.maxConsultationsPerSession ?? 0
      const sessionExhausted = spending && sessionCeiling > 0 && spending.issuedCount >= sessionCeiling
      if (state.consultations >= cfg.maxConsultationsPerRun || sessionExhausted) {
        state.refusedForBudget += 1
        rec({
          caseId: 'LIVE/budget-exhausted',
          expectation: 'a call beyond the run ceiling returns without contacting the provider',
          observed: {
            consultations: state.consultations,
            maxConsultationsPerRun: cfg.maxConsultationsPerRun,
            refused: state.refusedForBudget,
          },
          outcome: 'pass',
        })
        return {
          outcome: BUDGET_EXHAUSTED_OUTCOME,
          // Must be a string: the base tool declares `consultationId: {type:'string'}`
          // and the host validates the declared output. Returning null here made
          // every over-budget call look like a malformed result, and the caller
          // retried it.
          consultationId: `${BUDGET_EXHAUSTED_OUTCOME}-${state.refusedForBudget}`,
          advice: '',
          cancelled: false,
          timedOut: false,
          adviceWithheld: false,
          truncated: false,
          budgetRemaining: 0,
        }
      }

      // The host's cancellation and this plugin's own unload both have to end
      // the consultation. Combining them means a dispose during a call is not
      // silently ignored.
      const signal =
        unloadSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([exec?.signal, unloadSignal].filter(Boolean))
          : exec?.signal

      state.consultations += 1
      if (spending) spending.reserve()
      const value = await base.execute(args, signal === exec?.signal ? exec : { ...exec, signal }, {
        mode: gate?.mode,
        target: callTarget,
        maxAdviceTokens: gate?.settings?.advanced?.maxAdviceTokens,
        consultDeadlineMs: gate?.settings?.advanced?.consultDeadlineMs,
        beforeRequest: () => {
          const current = gateForTool(exec)
          if (current?.reason) return current.advice
          const target = targetFor(current)
          if (current?.mode !== gate?.mode || target.provider !== callTarget.provider || target.model !== callTarget.model) {
            return 'Advisor settings changed while waiting for consent. Ask again; nothing was sent.'
          }
          return null
        },
      })
      if (value && typeof value.consultationId === 'string') {
        state.consultationIds.push(value.consultationId)
        if (value.outcome === 'refused_no_consent') state.refusedTotal += 1
        const entry = runLedger.get(value.consultationId)
        if (spending && entry && !entry.requestIssued) spending.refund()
        if (callsSink && entry) callsSink.write(entry)
        const result = toToolResult(
          value,
          entry?.terminalReason ?? null,
          entry?.truncated ?? value.truncated ?? false,
        )
        rec({
          caseId: 'LIVE/consultation-returned',
          expectation:
            'the tool result carries the advice and the terminal reason, without inventing either',
          observed: {
            consultationId: value.consultationId,
            outcome: result.outcome,
            adviceChars: result.advice.length,
            cancelled: result.cancelled,
            timedOut: result.timedOut,
            truncated: result.truncated,
            terminalReason: entry?.terminalReason ?? null,
            // Three separate facts, never collapsed into one: numbers arrived,
            // numbers are trustworthy, and numbers are the provider's.
            usageKnown: Boolean(entry?.usageKnown),
            usageOrigin: entry?.usageOrigin ?? 'unknown',
          },
          outcome: 'pass',
        })
        return result
      }
      return toToolResult(value ?? {}, null)
    },
  }

  return {
    tool,
    state,
    config: cfg,
    ledger: runLedger,
    /** Summary for the run file. Contains no advice text. */
    summary() {
      return {
        runId: state.runId,
        provider: state.provider,
        model: state.model,
        consultations: state.consultations,
        maxConsultationsPerRun: state.maxConsultationsPerRun,
        refusedForBudget: state.refusedForBudget,
        refusedTotal: state.refusedTotal,
        consultationIds: [...state.consultationIds],
        injectAdvice: cfg.injectAdvice,
        maxAdviceTokens: cfg.maxAdviceTokens,
        note: 'consultations counts plugin-initiated model calls; it is not an HTTP attempt count',
      }
    },
  }
}

/**
 * Read the configuration from the plugin config, falling back to env.
 *
 * Env fallback exists so a run can be configured without editing a profile
 * patch. Two failure modes are handled explicitly here because both actually
 * happened in development:
 *
 *   - Reading `ctx.config` on a cordis context that did not declare `config` in
 *     its `inject` list throws. Config is already passed to `apply` as an
 *     argument, so this path exists only for callers that hand over a context
 *     and nothing else.
 *   - A key that resolves to `undefined` must be LEFT OUT, not written as
 *     `undefined`: object spread means an explicit `undefined` wins over the
 *     default, so `{ maxConsultationsPerRun: undefined }` silently disabled the
 *     ceiling instead of leaving it alone.
 */
export function liveConfigFrom(ctx, config = {}) {
  const env = (key) => {
    const raw = process.env[key]
    return raw === undefined || raw === '' ? undefined : raw
  }
  const numeric = (raw) => {
    if (raw === undefined) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  let fromCtx = {}
  try {
    fromCtx = (ctx && typeof ctx === 'object' && ctx.config) || {}
  } catch {
    fromCtx = {}
  }
  const pick = (key, envKey, parse = (v) => v) => {
    const direct = config[key] ?? fromCtx[key]
    if (direct !== undefined) return direct
    return parse(env(envKey))
  }
  const resolved = {
    provider: pick('provider', 'ADVISOR_PROVIDER'),
    model: pick('model', 'ADVISOR_MODEL'),
    maxAdviceTokens: pick('maxAdviceTokens', 'ADVISOR_MAX_ADVICE_TOKENS', numeric),
    maxConsultationsPerRun: pick('maxConsultationsPerRun', 'ADVISOR_MAX_CONSULTATIONS', numeric),
    consultDeadlineMs: pick('consultDeadlineMs', 'ADVISOR_DEADLINE_MS', numeric),
    // Which consultation focuses this mount has already been authorised for.
    // The consent branch asks the human only for focuses NOT in this list; a
    // headless host has no `userQuestions` service, so every unlisted focus
    // fails closed with `refused_no_consent`. Parsed as a comma-separated list
    // so a patch or env var can widen it.
    authorizedScopes: pick('authorizedScopes', 'ADVISOR_AUTHORIZED_SCOPES', (v) =>
      typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter((x) => x !== '') : v,
    ),
    injectAdvice: pick('injectAdvice', 'ADVISOR_INJECT_ADVICE', (v) => v !== 'false'),
    outputDir: pick('outputDir', 'ADVISOR_OUTPUT_DIR'),
    runId: pick('runId', 'ADVISOR_RUN_ID'),
  }
  for (const key of Object.keys(resolved)) {
    if (resolved[key] === undefined) delete resolved[key]
  }
  return resolved
}

function safeGet(ctx, serviceName) {
  try {
    const getter = ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : null
    return getter ?? null
  } catch {
    return null
  }
}

/**
 * Ask the host which model this session is already using.
 *
 * `agentDefaultModel` owns that selection. Reading it means the advisor consults
 * the same model the session chose instead of a provider name baked into a
 * plugin — which is the difference between "my advisor" and "some stranger's
 * provider receiving this session's work".
 */
function readSessionModel(ctx) {
  const selection = safeGet(ctx, 'agentDefaultModel')
  if (!selection || typeof selection.currentSelection !== 'function') return null
  try {
    const current = selection.currentSelection()
    if (!current || typeof current.provider !== 'string' || typeof current.model !== 'string') return null
    return { provider: current.provider, model: current.model }
  } catch {
    return null
  }
}

/**
 * Host entry point.
 *
 * Two independent halves, registered under two independent effects:
 *
 *   - the tool, for a consultation the *model* asks for (v0.1);
 *   - the client channel, for a consultation the *person* asks for (v0.2).
 *
 * They must fail independently. A profile whose `webServer` is unavailable still
 * gets the tool; a browser-less host still gets the channel-less tool. Tying
 * them together would mean a settings page that cannot mount silently removes a
 * capability the session was already using.
 */
export function apply(ctx, config = {}) {
  const unload = new AbortController()
  // Disposing the plugin must also stop a consultation that is still waiting.
  ctx.effect(() => () => unload.abort(), 'dsh-advisor.cancel')

  const live = liveConfigFrom(ctx, config)
  /**
   * The home whose `dsh-advisor/settings.json` this mount should respect.
   *
   * Only a real `profileContext.home` qualifies. `resolveHome` has a `~/.dsh`
   * fallback so the host half always has somewhere to write, but using that
   * fallback as a GATE input is a different question: a test mount, or a host
   * that has not exposed `profileContext` yet, would then read whatever an
   * unrelated profile left in `~/.dsh` — or the defaults, which say
   * `mode: manual` and would refuse every consultation.
   */
  const profileContext = safeGet(ctx, 'profileContext')
  const profileHome =
    profileContext && typeof profileContext.home === 'string' && profileContext.home !== ''
      ? profileContext.home
      : null
  const log = (event, detail) => {
    try {
      if (typeof ctx.logger === 'object' && ctx.logger && typeof ctx.logger.info === 'function') {
        ctx.logger.info(`dsh-advisor ${event}`, detail)
      }
    } catch {
      /* a logger that throws must not break a consultation */
    }
  }

  ctx.inject(['tools'], (child) => {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null
    const tools = typeof child.get === 'function' ? child.get('tools') : null
    if (!llm || !tools) return

    const userQuestions = safeGet(ctx, 'userQuestions')
    const advisor = createAdvisor({
      llm,
      config: live,
      defaults: readSessionModel(ctx),
      getDefaultModel: () => readSessionModel(ctx),
      getRootAgent: () => safeGet(ctx, 'agent') ?? null,
      getUserQuestions: () => {
        // Resolved lazily: the seam may appear after this plugin is applied.
        const live = safeGet(ctx, 'userQuestions')
        return live ?? userQuestions
      },
      unloadSignal: unload.signal,
      // The same file the settings page writes. The tool half must read it too,
      // or the master switch would only silence the half the person can see.
      //
      // Strictly the profile home, never a guessed one: `resolveHome` falls back
      // to `~/.dsh`, and gating on a file that is not the one this profile
      // actually uses would read `mode: manual` from the defaults and silently
      // refuse every consultation the person had enabled. An unknown home means
      // no gate, which is exactly the behaviour before the switch existed.
      home: profileHome,
      // A tool execution carries no session id, but the agent that issued it
      // does. That is enough to know whether a per-session grant applies.
      getSessionId: (exec) => {
        try {
          const agent = exec && exec.agent
          return agent && agent.session && typeof agent.session.id === 'string' ? agent.session.id : null
        } catch {
          return null
        }
      },
    })

    child.effect(() => tools.register(advisor.tool), 'dsh-advisor.tool')
    // Reporting needs a real profile: never write tasks into a guessed home.
    if (profileHome) child.effect(() => tools.register(createWorkReportTool({home:profileHome})), 'dsh-advisor.work-report')
  })

  // The person-facing half. Mounted on its own inject so a host without a web
  // server keeps the tool instead of losing the whole plugin.
  ctx.inject(['webServer'], (child) => {
    const host = createHost({
      ctx: child,
      home: resolveHome(safeGet(ctx, 'profileContext')),
      log,
      language: detectLanguage(ctx),
      getSession: (sessionId) => {
        const sessions = safeGet(ctx, 'sessions')
        if (!sessions || typeof sessions.get !== 'function') return null
        try {
          return sessions.get(sessionId) ?? null
        } catch {
          return null
        }
      },
      workspaceChanges: safeGet(ctx, 'workspaceChanges'),
    })
    const dispose = mountHostChannel({ ctx: child, host, log })
    child.effect(() => () => {
      host.abortAll()
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          /* already released */
        }
      }
    }, 'dsh-advisor.channel')
  })
}

/**
 * The language the advisor should write in.
 *
 * Read from the host locale rather than from a config key: a user who switched
 * the interface to English did not also want to go find a plugin setting to make
 * the advice readable.
 */
function detectLanguage(ctx) {
  try {
    const i18n = safeGet(ctx, 'i18n')
    const value = i18n && typeof i18n.getLocale === 'function' ? i18n.getLocale() : null
    const id = typeof value === 'string' ? value : value && typeof value.id === 'string' ? value.id : ''
    return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

export { ADVISOR_FOCUS, ADVISOR_TOOL_NAME, BUDGET_EXHAUSTED_OUTCOME, DEFAULT_AUTHORIZED_SCOPES }
