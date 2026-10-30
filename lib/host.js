/**
 * dsh-advisor v0.2 — host wiring: settings, models, materials preview, and the
 * user-initiated consultation, all behind one authenticated channel.
 *
 * This module exists so `index.js` stays about the tool. Everything a *person*
 * does — open settings, pick a model, preview what will be sent, start, cancel,
 * read the history, say what happened afterwards — arrives here as an RPC
 * endpoint and is answered from the same state the tool uses.
 *
 * Two decisions worth naming:
 *
 * 1. Delivery to the working model is opt-in per consultation, and is done by
 *    appending to that agent's inbox rather than by synthesising a user message.
 *    A user message would look like the *human* asked, which is exactly the
 *    confusion this feature must avoid: the opinion came from a different model,
 *    and the transcript has to keep saying so.
 *
 * 2. Nothing here sends a request to a provider except `consult.start` and
 *    `check.connection`, and `check.connection` only runs when a human pressed
 *    it. A settings page that probes the network on open spends someone's money
 *    to decide how to draw a label.
 */

import { randomUUID } from 'node:crypto'

import { loadSettings, saveSettings, applySettingsPatch, grantSession, revokeSession, resolveHome, resolveConsultTarget, effectiveMode } from './settings.js'
import { collectMaterials, describeMaterials } from './materials.js'
import { collectStream, raceStream } from './advisor.js'
import { createConsultService, PREPARE_TIMEOUT_MS } from './consult.js'
import { mountChannel } from './rpc.js'
import { STATES } from './history.js'
import { makeAdmission } from './rpc.js'
import { createWorkflow } from './workflow.js'

/** The channel name the client calls. Changing it breaks a running client. */
export const CHANNEL = '/plugin/dsh-advisor'

/**
 * The settings an unconfigured install reports.
 *
 * Deliberately a separate concept from "the plugin is running": a mounted plugin
 * with no model chosen is `needs-model`, not `ready`, and it must not claim to
 * be usable — `ready` here means "a consultation could be started right now",
 * which is a stronger claim than "the code loaded".
 */
function statusOf(settings, sessionSelection) {
  const target = resolveConsultTarget(settings, sessionSelection)
  if (target.source === 'missing') return 'needs-model'
  return 'ready'
}

/** Best-effort human label for a provider/model pair. */
function describeModel(target, providers) {
  if (!target.provider) return ''
  const entry = providers.find((provider) => provider && provider.id === target.provider)
  const providerLabel = entry && typeof entry.label === 'string' ? entry.label : target.provider
  return `${providerLabel} / ${target.model ?? '—'}`
}

export function createHost({
  ctx,
  home,
  log = () => {},
  language = 'zh',
  getSession,
  workspaceChanges = null,
  prepareTimeoutMs = PREPARE_TIMEOUT_MS,
  connectionTimeoutMs = 20000,
}) {
  const cache = { settings: null }

  function settings() {
    if (cache.settings) return cache.settings
    cache.settings = loadSettings(home)
    return cache.settings
  }

  function persist(next) {
    cache.settings = saveSettings(home, next)
    return cache.settings
  }

  function sessionSelection(sessionId) {
    try {
      const service = ctx.get ? ctx.get('agentDefaultModel') : null
      if (!service || typeof service.currentSelection !== 'function') return null
      const selection = service.currentSelection()
      // A per-session selection would be better, but the host service exposes one
      // current selection; reporting it beats inventing a per-session value.
      if (!selection || typeof selection.provider !== 'string') return null
      return { provider: selection.provider, model: selection.model ?? null }
    } catch {
      return null
    }
  }

  function llmService() {
    const llm = ctx.get ? ctx.get('llm') : null
    return llm && typeof llm.stream === 'function' ? llm : null
  }

  // `llm.listModels()` is async on the host service, so the whole catalogue has
  // to be awaited. Reading it synchronously yields Promises and an empty list,
  // which is what made the model picker offer only the placeholder option.
  async function listProviders() {
    const llm = llmService()
    if (!llm || typeof llm.listProviders !== 'function') return { providers: [], models: {} }
    let providers = []
    try {
      providers = (await llm.listProviders()) || []
    } catch {
      providers = []
    }
    const shape = providers.map((provider) => ({
      id: String(provider?.id ?? ''),
      label: typeof provider?.label === 'string' ? provider.label : String(provider?.id ?? ''),
      ...(provider?.defaultModel ? { defaultModel: String(provider.defaultModel) } : {}),
    }))
    const models = {}
    const catalogueErrors = {}
    for (const provider of shape) {
      if (typeof llm.listModels !== 'function') {
        models[provider.id] = provider.defaultModel ? [{ id: provider.defaultModel, label: provider.defaultModel }] : []
        continue
      }
      try {
        const entries = (await llm.listModels(provider.id)) || []
        models[provider.id] = entries.map((entry) =>
          typeof entry === 'string'
            ? { id: entry, label: entry }
            : { id: String(entry?.id ?? ''), label: typeof entry?.name === 'string' ? entry.name : typeof entry?.label === 'string' ? entry.label : String(entry?.id ?? '') },
        )
      } catch (err) {
        models[provider.id] = []
        // Surface the reason instead of an empty list: an adapter without a
        // credential returns [] silently, and a bare empty picker hides that.
        catalogueErrors[provider.id] = String(err?.code ? `${err.code}: ${err.message}` : err?.message || err)
      }
    }
    return { providers: shape, models, catalogueErrors }
  }

  const consult = createConsultService({
    llm: {
      // Resolved per call: the llm service can be replaced on reload, and a
      // captured reference would keep consulting a disposed runtime.
      stream: (options) => {
        const live = llmService()
        if (!live) throw new Error('llm service is unavailable')
        return live.stream(options)
      },
    },
    home,
    getSettings: settings,
    saveSettings: persist,
    getSession,
    getSessionSelection: sessionSelection,
    workspaceChanges,
    log,
    language,
    prepareTimeoutMs,
    validateRequest: (sessionId, request) => {
      if (request?.workItemId && workflow.get(sessionId, request.workItemId).revision !== request.workRevision) {
        throw new Error('待办或执行回报已更新，请重新生成复查问题并预览。未发出模型请求。')
      }
    },
  })

  const workflow = createWorkflow({ home, getConsultation: consult.get, getSettings: settings,
    getAgent: sessionId => { try { return ctx.get?.('agents')?.get?.(sessionId) || null } catch { return null } } })

  // ---------------------------------------------------------------- delivery

  /**
   * Hand an opinion to the working model.
   *
   * `followup` starts a turn; `inject` only queues. Which one to use depends on
   * why the opinion exists: advice the user asked for while the model was idle
   * should wake it, and advice that arrived mid-turn should not interrupt.
   * The text is framed as advice from another model so the transcript records
   * who said it.
   */
  async function deliverToModel(sessionId, record) {
    let agent = null
    try {
      const agents = ctx.get ? ctx.get('agents') : null
      agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
    } catch {
      agent = null
    }
    if (!agent) return { ok: false, reason: 'no-agent' }
    const advice = String(record.advice || '')
    if (advice === '') return { ok: false, reason: 'no-advice-text' }
    const stateLine = record.state === STATES.truncated
      ? '（注意：顾问输出被截断，结尾缺失，不能当作完整审查）'
      : ''
    const text = [
      `【顾问意见 · ${record.target.model ?? '未知模型'}】${stateLine}`,
      advice,
      '',
      `请核验以上意见：逐条判断哪些成立、哪些是误报，并说明依据。若你核验后认为某条不成立，请说明理由——拒绝一条建议同样是有效结果。`,
      `（consultationId=${record.id}）`,
    ].join('\n')
    // The message is built here rather than with `createUserMessage` because a
    // profile install cannot resolve `@deepseek-ai/dsh-llm`; the shape is the
    // one that factory produces. `cordis-host-runner` is a source kind the host
    // itself uses when a plugin hands the agent programmatic input, and it is in
    // `MessageSourceMap` — an invented kind such as `plugin` is not, and the
    // transcript would be lying about who spoke.
    const payload = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'cordis-host-runner' },
    }
    try {
      if (typeof agent.followup === 'function') {
        await agent.followup(payload)
        return { ok: true, via: 'followup' }
      }
      if (typeof agent.inject === 'function') {
        await agent.inject(payload)
        return { ok: true, via: 'inject' }
      }
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) }
    }
    return { ok: false, reason: 'no-delivery-method' }
  }

  // --------------------------------------------------------------- endpoints

  const handlers = {
    async 'work.list'(params) { return workflow.list(params?.sessionId) },
    async 'work.create'(params) { return {item:workflow.create(params?.sessionId,params?.input)} },
    async 'work.edit'(params) { return {item:workflow.edit(params?.sessionId,params?.workItemId,params?.input,params?.expectedRevision)} },
    async 'work.preview'(params) { return workflow.preview(params?.sessionId,params?.workItemId,params?.expectedRevision) },
    async 'work.dispatch'(params) { return {item:await workflow.dispatch(params?.sessionId,params?.workItemId,params)} },
    async 'work.review'(params) { return {item:workflow.review(params?.sessionId,params?.workItemId,params)} },
    async 'work.recheck'(params) { return workflow.recheckRequest(params?.sessionId,params?.workItemId) },
    async 'work.export'(params) { return {markdown:workflow.exportMarkdown(params?.sessionId)} },
    async 'settings.get'(params) {
      const current = settings()
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const selection = sessionSelection(sessionId)
      const target = resolveConsultTarget(current, selection)
      const catalogue = await listProviders()
      return {
        settings: current,
        status: statusOf(current, selection),
        mode: sessionId ? effectiveMode(current, sessionId) : current.mode,
        sessionId,
        sessionGranted: Boolean(sessionId && current.sessionGrants[sessionId]),
        resolved: {
          ...target,
          label: describeModel(target, catalogue.providers),
        },
        sessionSelection: selection,
        providers: catalogue.providers,
        models: catalogue.models,
        catalogueErrors: catalogue.catalogueErrors,
        historyLimit: current.advanced.historyLimit,
      }
    },

    async 'settings.patch'(params) {
      const next = applySettingsPatch(settings(), params?.patch || {})
      return { settings: persist(next) }
    },

    async 'settings.grant'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const next = params?.granted ? grantSession(settings(), sessionId) : revokeSession(settings(), sessionId)
      return { settings: persist(next), granted: Boolean(params?.granted) }
    },

    async 'materials.preview'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const session = getSession(sessionId)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), prepareTimeoutMs)
      let preview
      try {
        const race = await raceStream(collectMaterials({
          settings: settings(), session, sessionId, request: params?.request || {},
          workspaceChanges, cwd: session?.cwd ?? null, signal: controller.signal,
        }), controller.signal, 0)
        if (race.kind === 'aborted') return { ok: false, reason: '准备材料超时，请稍后重试。未发出模型请求。' }
        preview = race.result
      } finally {
        clearTimeout(timer)
      }
      if (!preview.ok) return { ok: false, reason: preview.reason }
      return {
        ok: true,
        chars: preview.chars,
        digest: preview.digest,
        target: resolveConsultTarget(settings(), sessionSelection(sessionId)),
        summary: describeMaterials(preview.materials),
        // The exact text the user is approving. Not a reconstruction of it.
        text: preview.text,
        materials: preview.materials.map((material) => ({
          kind: material.kind,
          label: material.label,
          chars: material.chars,
          truncated: Boolean(material.truncated),
          absent: Boolean(material.absent),
          reason: material.reason ?? null,
          // The preview has to say this, not just the request body: a user
          // approving "plan 546 字" is approving the wrong work when that plan
          // was written before this turn began.
          fromEarlierTurn: Boolean(material.fromEarlierTurn),
        })),
      }
    },

    async 'consult.start'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
      const request = params?.request || {}
      if (request.workItemId) {
        const item = workflow.get(sessionId, request.workItemId)
        if (item.revision !== request.workRevision) throw Object.assign(new Error('待办或执行回报已更新，请重新生成复查问题并预览。'), { code: 'work-changed' })
      }
      if (!request.expectedDigest || !request.expectedTarget?.provider || !request.expectedTarget?.model) {
        throw Object.assign(new Error('请先预览材料和顾问模型，再确认开始咨询。'), { code: 'preview-required' })
      }
      const result = await consult.start({ sessionId, request })
      if (result.accepted && request.workItemId) workflow.linkRecheck(sessionId, request.workItemId, result.record.id, request.workRevision)
      // Delivery is attempted only after a settled opinion exists, and only when
      // the user's setting says to hand it back. Doing it here (not inside the
      // service) keeps "produce an opinion" and "change the working session"
      // separable, which is what makes the setting meaningful.
      if (result.accepted && result.done) {
        result.done.then(async (record) => {
          if (!record) return
          const delivered = record.state === STATES.returned || record.state === STATES.truncated
          if (!delivered || record.delivery !== 'return') return
          const outcome = await deliverToModel(sessionId, record)
          if (outcome.ok) {
            try {
              consult.annotate(sessionId, record.id, { delivered: true, deliveredVia: outcome.via })
            } catch {
              /* the record is decorative here; delivery already happened */
            }
          }
        }).catch(err => log('delivery-error', { message: String(err?.message || err) }))
      }
      return {
        accepted: result.accepted,
        record: result.record,
        materials: result.materials
          ? { chars: result.materials.chars, summary: describeMaterials(result.materials.materials) }
          : null,
      }
    },

    async 'consult.cancel'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const consultationId = typeof params?.consultationId === 'string' ? params.consultationId : null
      return consult.cancel(sessionId, consultationId)
    },

    async 'consult.list'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      if (!sessionId) return { records: [], running: [] }
      return { records: consult.list(sessionId), running: consult.inFlightCount() }
    },

    async 'consult.get'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const consultationId = typeof params?.consultationId === 'string' ? params.consultationId : null
      return { record: consult.get(sessionId, consultationId) }
    },

    async 'consult.annotate'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const consultationId = typeof params?.consultationId === 'string' ? params.consultationId : null
      const record = consult.annotate(sessionId, consultationId, params?.patch || {})
      return { record }
    },

    /**
     * Hand one settled opinion to the working model on request.
     *
     * Separate from the `return` delivery setting on purpose. The setting is a
     * standing preference; this is a single decision about a single opinion, and
     * it is the only path that turns "the advisor said something" into "the model
     * has to answer for it". It also only ever acts on a record that already has
     * text, so a truncated or empty answer cannot be delivered as if it were a
     * review.
     */
    async 'consult.deliver'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const consultationId = typeof params?.consultationId === 'string' ? params.consultationId : null
      const record = consult.get(sessionId, consultationId)
      if (!record) return { ok: false, reason: 'not-found', message: '找不到这条咨询记录。' }
      if (!record.advice) {
        return { ok: false, reason: 'no-advice-text', message: '这条咨询没有可交付的正文。' }
      }
      const outcome = await deliverToModel(sessionId, record)
      if (outcome.ok) {
        consult.annotate(sessionId, consultationId, { delivered: true })
        return { ...outcome, record: consult.get(sessionId, consultationId) }
      }
      return {
        ...outcome,
        message:
          outcome.reason === 'no-agent'
            ? '本会话当前没有可唤醒的主力 agent，意见只保留在卡片里。'
            : `交付失败：${outcome.reason}`,
      }
    },

    async 'consult.clear'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      return consult.clear(sessionId)
    },

    /**
     * Ask the provider whether this target answers at all.
     *
     * Only reachable from a button. A single short prompt, a hard timeout, and
     * the raw failure reported verbatim: a connection check that says "failed"
     * without the provider's own words sends the user hunting through config
     * files for a message the host already had.
     */
    async 'check.connection'(params) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null
      const current = settings()
      const target = resolveConsultTarget(current, sessionSelection(sessionId))
      if (!target.provider || !target.model) {
        return { ok: false, code: 'no-model', message: '尚未选择顾问模型。' }
      }
      const llm = llmService()
      if (!llm) return { ok: false, code: 'no-llm', message: '宿主没有可用的 llm 服务。' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), connectionTimeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      const startedAt = Date.now()
      try {
        const stream = llm.stream({
          provider: target.provider,
          model: target.model,
          system: 'Reply with the single word OK.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          maxTokens: 8,
          signal: controller.signal,
        })
        const race = await raceStream(collectStream(stream), controller.signal, 0)
        if (race.kind === 'aborted') {
          return { ok: false, code: 'timeout', message: '连接检查超时，本地已停止等待。', elapsedMs: Date.now() - startedAt }
        }
        const { text, finish } = race.result
        const elapsedMs = Date.now() - startedAt
        if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
          return {
            ok: false,
            code: finish.failure?.code || finish.kind,
            message: finish.failure?.message || `调用结束于 ${finish.kind}`,
            elapsedMs,
          }
        }
        if (!finish || !text.trim()) {
          return { ok: false, code: 'incomplete-response', message: '模型未返回完整的连接检查结果。', elapsedMs: Date.now() - startedAt }
        }
        return { ok: true, model: `${target.provider}/${target.model}`, elapsedMs, sample: text.slice(0, 40) }
      } catch (err) {
        return {
          ok: false,
          code: controller.signal.aborted ? 'timeout' : 'exception',
          message: String(err?.message || err),
          elapsedMs: Date.now() - startedAt,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }

  return { handlers, consult, workflow, settings, persist, abortAll: () => { consult.abortAll(); workflow.abortAll() }, CHANNEL }
}

/**
 * Mount the channel for one plugin instance.
 *
 * Returns a disposer that the caller stores in its context effect. Every failure
 * path here is logged and tolerated: a settings page that cannot reach its host
 * must degrade to a message, not take the plugin (and its tool) down with it.
 */
export function mountHostChannel({ ctx, host, log = () => {} }) {
  const connection = ctx.get ? ctx.get('connection') : null
  const admission = makeAdmission(connection)
  const dispose = mountChannel({
    ctx,
    channel: CHANNEL,
    handler: async (endpoint, params) => {
      const handler = host.handlers[endpoint]
      if (!handler) {
        const error = new Error(`unknown endpoint ${JSON.stringify(endpoint)}`)
        error.code = 'not-found'
        throw error
      }
      return handler(params)
    },
    admission,
    log,
  })
  if (!dispose) log('dsh-advisor: the client channel is unavailable; the settings page will report it')
  return dispose
}

export { resolveHome, effectiveMode }
