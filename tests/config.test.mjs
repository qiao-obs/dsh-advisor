/**
 * Configuration resolution, and the packaging contract the host reads.
 *
 * Two of these tests guard defects that actually shipped at some point:
 *
 *   - spreading `undefined` over a default silently disabled a ceiling, because
 *     an explicit `undefined` wins in object spread;
 *   - reading `ctx.config` on a context that did not declare it in `inject`
 *     throws, which made the plugin fail to mount in a real profile even though
 *     every offline test passed.
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DEFAULT_LIVE_CONFIG, liveConfigFrom } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function withEnv(vars, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('an explicit config value wins over the environment', () => {
  withEnv({ ADVISOR_PROVIDER: 'from-env' }, () => {
    const resolved = liveConfigFrom(null, { provider: 'from-config' })
    assert.equal(resolved.provider, 'from-config')
  })
})

test('absent keys are omitted, never written as undefined', () => {
  withEnv({ ADVISOR_MAX_CONSULTATIONS: undefined }, () => {
    const resolved = liveConfigFrom(null, {})
    // `'maxConsultationsPerRun' in resolved === true` with value undefined would
    // override the default when merged, which is how a ceiling gets disabled by
    // accident.
    assert.equal('maxConsultationsPerRun' in resolved, false)
    assert.equal('provider' in resolved, false)
  })
})

test('an empty environment variable is treated as absent', () => {
  withEnv({ ADVISOR_PROVIDER: '', ADVISOR_MAX_ADVICE_TOKENS: '' }, () => {
    const resolved = liveConfigFrom(null, {})
    assert.equal('provider' in resolved, false)
    assert.equal('maxAdviceTokens' in resolved, false)
  })
})

test('numeric environment values are parsed once, and junk is dropped', () => {
  withEnv({ ADVISOR_MAX_ADVICE_TOKENS: '900', ADVISOR_DEADLINE_MS: 'not-a-number' }, () => {
    const resolved = liveConfigFrom(null, {})
    assert.equal(resolved.maxAdviceTokens, 900)
    assert.equal('consultDeadlineMs' in resolved, false)
  })
})

test('several values still fall back to the documented defaults', () => {
  const resolved = liveConfigFrom(null, {})
  const merged = { ...DEFAULT_LIVE_CONFIG, ...resolved }
  assert.equal(merged.maxAdviceTokens, DEFAULT_LIVE_CONFIG.maxAdviceTokens)
  assert.equal(merged.maxConsultationsPerRun, DEFAULT_LIVE_CONFIG.maxConsultationsPerRun)
  // And the two that must never be guessed stay unset.
  assert.equal(merged.provider, null)
  assert.equal(merged.model, null)
})

test('a context that exposes config is read', () => {
  const resolved = liveConfigFrom({ config: { model: 'from-ctx' } }, {})
  assert.equal(resolved.model, 'from-ctx')
})

test('a context that throws on config does not break the mount', () => {
  const hostile = {
    get config() {
      throw new Error('cannot get property "config" without inject')
    },
  }
  const resolved = liveConfigFrom(hostile, { provider: 'still-here' })
  assert.equal(resolved.provider, 'still-here')
})

test('a comma-separated scope list becomes an array', () => {
  withEnv({ ADVISOR_AUTHORIZED_SCOPES: 'plan, diff' }, () => {
    assert.deepEqual(liveConfigFrom(null, {}).authorizedScopes, ['plan', 'diff'])
  })
})

test('injectAdvice can be turned off from the environment', () => {
  withEnv({ ADVISOR_INJECT_ADVICE: 'false' }, () => {
    assert.equal(liveConfigFrom(null, {}).injectAdvice, false)
  })
})

test('the manifest points at things that exist', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  assert.equal(manifest.name, 'dsh-advisor')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')

  // The host resolves the bundle patch through this field, so a typo here means
  // the plugin installs and then simply never runs.
  const patch = manifest.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string')
  assert.ok(existsSync(join(ROOT, patch)), `${patch} must exist`)

  for (const entry of manifest.files) {
    assert.ok(existsSync(join(ROOT, entry)), `${entry} is listed in files but missing`)
  }

  // The entry point must be the module this test just imported.
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['.'], './lib/index.js')
})

test('the shipped patch mounts the plugin without choosing a provider', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-advisor/u)
  // A patch that names a provider would send a session's work to a model the
  // user never selected.
  assert.equal(/provider:/u.test(patch), false)
  assert.equal(/model:/u.test(patch), false)
})
