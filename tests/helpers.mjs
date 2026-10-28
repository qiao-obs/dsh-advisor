/**
 * Shared fakes for the test suite.
 *
 * The plugin is written so that everything it needs is injected, which means the
 * whole thing can be exercised with a fake `llm` and a fake `tools` — no
 * provider, no network, no cost. Anything that cannot be tested this way is a
 * design smell in the plugin, not a gap in the test.
 */

export const ADVICE = 'Check the caller first. Then confirm the empty object is handled.'

/**
 * A fake `LlmRuntime`. Only `stream` exists, because it is the only method the
 * advisor calls.
 *
 * `mode: 'hang'` produces a stream that ends only when its request signal is
 * aborted. That is what makes the cancellation test a real cancellation test
 * instead of a race the fake always loses.
 */
export function makeFakeLlm({ mode = 'normal', text = ADVICE, usage = null } = {}) {
  const state = { calls: 0, requests: [], mode }
  const llm = {
    state,
    stream(request) {
      state.calls += 1
      state.requests.push(request)
      const signal = request && request.signal
      const current = state.mode
      return (async function* generate() {
        if (current === 'hang') {
          await new Promise((resolve) => {
            if (!signal) {
              const timer = setTimeout(resolve, 5000)
              if (timer && typeof timer.unref === 'function') timer.unref()
              return
            }
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          // Ends without a finish chunk: an adapter that stopped, not a provider
          // that answered.
          return
        }
        yield { type: 'text-delta', text }
        if (usage) yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return llm
}

/** A fake `tools` service that records what was registered. */
export function makeFakeTools() {
  const registered = new Map()
  return {
    registered,
    register(tool) {
      registered.set(tool.name, tool)
      return () => registered.delete(tool.name)
    },
    list() {
      return [...registered.keys()]
    },
    get(toolName) {
      return registered.get(toolName) ?? null
    },
  }
}

/** A minimal cordis-shaped ctx: `get`, `effect`, `inject`. */
export function makeFakeCtx({ llm, tools, config = {}, services = {} } = {}) {
  const table = { llm, tools, ...services }
  const disposers = []
  const child = {
    get: (serviceName) => table[serviceName] ?? null,
    effect(fn, label) {
      const dispose = fn()
      disposers.push({ label, dispose })
      return dispose
    },
  }
  const ctx = {
    config,
    get: (serviceName) => table[serviceName] ?? null,
    effect: child.effect,
    inject(names, callback) {
      callback(child)
      return () => {}
    },
    _table: table,
    _disposers: disposers,
    _dispose() {
      for (const entry of [...disposers].reverse()) {
        if (typeof entry.dispose === 'function') entry.dispose()
      }
      disposers.length = 0
    },
  }
  return ctx
}

/** Count of live timers in this process. Used to prove nothing was leaked. */
export function timerCount() {
  const info = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : []
  return info.filter((entry) => entry === 'Timeout').length
}

/** A tool-call context as the host hands it to `execute`. */
export function execFor(callId, signal = null, agent = null) {
  return { callId, signal, agent }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
