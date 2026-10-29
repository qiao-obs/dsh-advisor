/**
 * dsh-advisor v0.2 — the client↔host channel.
 *
 * Why this exists instead of `connection.rpc.handle`: in the desktop build the
 * `connection` service is constructed with `['credentials']` only, so its
 * `rpc.handle()` hands the channel to the /api router by touching
 * `owner.webServer`, and that access throws "cannot get property webServer
 * without inject" at activation. `webServer.register` has no such dependency, so
 * the bridge is a prefix route that speaks the same envelope the /api router
 * does. The client half calls it with `connection.rpc.call`, which needs no
 * knowledge of any of this.
 *
 * Two invariants, both learned the hard way elsewhere:
 *
 * 1. The route must be released with the plugin's context. Registering a prefix
 *    route and returning a disposer that the loader drops means that after a
 *    hot reload the second registration throws "duplicate prefix route" and the
 *    plugin appears to break on every edit.
 *
 * 2. A request that the host's own admission check would reject must be rejected
 *    here too, before the body is read. Otherwise a page in another origin could
 *    spend this plugin's provider budget.
 */

const BODY_MAX = 4 * 1024 * 1024

/**
 * Build the JSON-in/JSON-out handler for one channel.
 *
 * Protocol (identical to `/api`): path `<channel>/<endpoint>`, POST only,
 * content-type `application/json`, body `{ rpcId, method, params }`. Success is
 * `{ rpcId, ok: true, value }`; a handler failure is `{ rpcId, ok: false,
 * error: { code, message } }` with a 200 so the client can distinguish a refused
 * operation from a broken transport.
 */
export function rpcHandler(channel, handler) {
  const prefix = `${channel}/`

  return async function handle(req, res) {
    const rawUrl = typeof req.url === 'string' ? req.url : ''
    const path = rawUrl.split('?')[0]
    if (req.method !== 'POST') {
      return writeText(res, 404, 'not found')
    }
    if (!path.startsWith(prefix)) {
      return writeText(res, 404, 'not found')
    }
    const endpoint = path.slice(prefix.length)
    if (!endpoint) {
      return writeText(res, 404, 'not found')
    }
    const contentType = String(req.headers['content-type'] || '')
    if (!contentType.toLowerCase().includes('application/json')) {
      return writeText(res, 415, 'expected application/json')
    }

    let body
    try {
      body = await readJson(req)
    } catch (err) {
      return writeJson(res, 200, {
        rpcId: null,
        ok: false,
        error: { code: 'bad-request', message: `body is not JSON: ${errText(err)}` },
      })
    }
    const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : null
    const method = body && typeof body.method === 'string' ? body.method : null
    if (method !== endpoint) {
      return writeJson(res, 200, {
        rpcId,
        ok: false,
        error: {
          code: 'bad-request',
          message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        },
      })
    }

    try {
      const value = await handler(endpoint, (body && body.params) ?? {}, req)
      return writeJson(res, 200, { rpcId, ok: true, value: value === undefined ? null : value })
    } catch (err) {
      return writeJson(res, 200, {
        rpcId,
        ok: false,
        error: {
          code: typeof err?.code === 'string' ? err.code : 'internal',
          message: errText(err),
        },
      })
    }
  }
}

function errText(err) {
  if (err && typeof err.message === 'string') return err.message
  return String(err)
}

function writeText(res, status, text) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(text)
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Decide whether this request may reach the handler at all.
 *
 * `connection.requestRejection` is defined on `connection`'s prototype, so it
 * must be called method-style; a destructured copy loses `this` and every request
 * looks unauthorized (401). When the method is absent the plugin falls back to a
 * loopback check rather than admitting everything.
 */
export function makeAdmission(connection) {
  return function reject(req) {
    if (!connection || typeof connection.requestRejection !== 'function') {
      return isLoopback(req) ? undefined : 403
    }
    try {
      return connection.requestRejection(req)
    } catch {
      return 403
    }
  }
}

function isLoopback(req) {
  const remote = req.socket && req.socket.remoteAddress
  if (typeof remote !== 'string') return false
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/**
 * Register the channel and return the disposer that releases it.
 *
 * `webServer.register` may return a disposer, a promise of one, or nothing,
 * depending on the build. All three are normalized here so the caller can always
 * store a synchronous disposer in its context effect.
 */
export function mountChannel({ ctx, channel, handler, admission, log = () => {} }) {
  const webServer = ctx.get ? ctx.get('webServer') : null
  if (!webServer || typeof webServer.register !== 'function') {
    log('dsh-advisor: webServer is unavailable; the settings page cannot reach the host')
    return null
  }

  const handle = rpcHandler(channel, async (endpoint, params, req) => {
    const rejection = admission ? admission(req) : undefined
    if (rejection === 401 || rejection === 403) {
      const error = new Error('this request may not use the advisor channel')
      error.code = 'unauthorized'
      error.status = rejection
      throw error
    }
    return handler(endpoint, params, req)
  })

  const routeHandler = async (req, res) => {
    const rejection = admission ? admission(req) : undefined
    if (rejection === 401) return writeText(res, 401, 'unauthorized')
    if (rejection === 403) return writeText(res, 403, 'forbidden')
    try {
      await handle(req, res)
    } catch (err) {
      if (!res.writableEnded) writeText(res, 500, 'internal error')
      log(`dsh-advisor: channel failure: ${errText(err)}`)
    }
  }

  let dispose = null
  let released = false
  try {
    const returned = webServer.register({ kind: 'prefix', path: channel, handler: routeHandler })
    if (typeof returned === 'function') {
      dispose = returned
    } else if (returned && typeof returned.then === 'function') {
      // A promise-returning build: the real disposer arrives later. If the plugin
      // is released before it does, the release is remembered and applied then —
      // otherwise a hot reload leaves the old route mounted and the next
      // registration throws "duplicate prefix route".
      returned.then(
        (value) => {
          if (typeof value !== 'function') return
          if (released) {
            try {
              value()
            } catch { /* the release below already ran */ }
            return
          }
          dispose = value
        },
        (err) => {
          log(`dsh-advisor: route registration failed: ${errText(err)}`)
        },
      )
    }
  } catch (err) {
    log(`dsh-advisor: could not register the channel: ${errText(err)}`)
    return null
  }

  return () => {
    released = true
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch (err) {
      log(`dsh-advisor: channel disposal failed: ${errText(err)}`)
    }
    dispose = null
  }
}
