/**
 * dsh-advisor v0.2 — the settings this plugin actually owns.
 *
 * Two rules shaped this file:
 *
 * 1. The plugin's own preferences are NOT loader config. Loader config
 *    (`cordis.patch.yml`) is edited by hand and re-read on every reload; a
 *    settings page that wrote there would be editing the thing that boots the
 *    plugin. So user choices live in one JSON file under the profile home, and
 *    `config` keeps only what an operator sets before first boot.
 *
 * 2. Every value has a stated default and a validator. A settings page that
 *    accepts 0 for "deadline" must know that 0 means "no deadline" everywhere
 *    else, or the UI and the runner disagree about what the user picked. The
 *    normalizer below is the single place that decides.
 *
 * The file is per-profile, not per-session: "which model should advise me" and
 * "how long may a consultation run" are properties of the installation, and
 * re-answering them in every session is the kind of tax that makes a plugin get
 * uninstalled. What IS per-session — "this session is allowed to consult without
 * asking again" — is kept in `sessionGrants` and expires with the session.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Bumped only when an existing file needs rewriting to stay valid. */
export const SETTINGS_VERSION = 1

/** How the advisor is reached. `manual` is the default on purpose. */
export const MODES = ['manual', 'confirm', 'auto']

/**
 * How the advice is delivered once it exists.
 *
 * `show`   — the user reads it; the working model is never told.
 * `return` — the advice is handed back to the working model as a follow-up
 *            turn, so it can act on or argue with it.
 */
export const DELIVERIES = ['show', 'return']

/** Which materials a consultation may carry. Order is presentation order. */
export const MATERIAL_KINDS = ['question', 'selection', 'plan', 'diff', 'test']

export const MATERIAL_LABELS = {
  question: '本次问题',
  selection: '选中内容',
  plan: '当前方案',
  diff: '当前改动',
  test: '测试失败',
}

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  /**
   * Master switch. Off means the plugin is inert: no entry in the composer, no
   * card, no model call, whatever the other preferences say. Defaults to on so
   * an existing installation keeps behaving the way it did before the switch
   * existed; a person who turns it off has said so explicitly.
   */
  enabled: true,
  /**
   * `manual` first: an advisor that speaks without being asked is noise, and a
   * user who has not yet seen it work has no basis to grant more.
   */
  mode: 'manual',
  /**
   * `session` follows the model the conversation is already using. A fixed
   * provider is an explicit choice, never a fallback: silently consulting a
   * different vendor would send this session's work somewhere the user never
   * picked.
   */
  target: { mode: 'session', provider: null, model: null },
  materials: { question: true, selection: true, plan: true, diff: false, test: false },
  delivery: 'show',
  advanced: {
    /** Output cap handed to the provider. Not a guarantee about the bill. */
    maxAdviceTokens: 1000,
    /** Total budget for one consultation; 0 disables the internal deadline. */
    consultDeadlineMs: 60000,
    /** Ceiling on consultations per session. 0 disables the ceiling. */
    maxConsultationsPerSession: 200,
    /** How many finished consultations this session keeps for review. */
    historyLimit: 50,
  },
  /**
   * Session ids that were granted automatic use. Kept so a reload does not
   * silently re-arm a prompt the user already answered, and pruned so the file
   * does not grow without bound.
   */
  sessionGrants: {},
}

const GRANT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_GRANTS = 200

function clampInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * Coerce anything into a valid settings object.
 *
 * This never throws. A corrupt or hand-edited file must not make the plugin
 * unloadable: the failure mode of a bad preference is "the default applies", not
 * "the feature disappears".
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const target = source.target && typeof source.target === 'object' ? source.target : {}
  const materials = source.materials && typeof source.materials === 'object' ? source.materials : {}
  const advanced = source.advanced && typeof source.advanced === 'object' ? source.advanced : {}

  const normalized = {
    version: SETTINGS_VERSION,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
    mode: oneOf(source.mode, MODES, DEFAULT_SETTINGS.mode),
    target: {
      mode: target.mode === 'fixed' ? 'fixed' : 'session',
      provider: typeof target.provider === 'string' && target.provider !== '' ? target.provider : null,
      model: typeof target.model === 'string' && target.model !== '' ? target.model : null,
    },
    materials: {},
    delivery: oneOf(source.delivery, DELIVERIES, DEFAULT_SETTINGS.delivery),
    advanced: {
      maxAdviceTokens: clampInt(advanced.maxAdviceTokens, DEFAULT_SETTINGS.advanced.maxAdviceTokens, {
        min: 64,
        max: 32000,
      }),
      consultDeadlineMs: clampInt(advanced.consultDeadlineMs, DEFAULT_SETTINGS.advanced.consultDeadlineMs, {
        min: 0,
        max: 600000,
      }),
      maxConsultationsPerSession: clampInt(
        advanced.maxConsultationsPerSession,
        DEFAULT_SETTINGS.advanced.maxConsultationsPerSession,
        { min: 0, max: 10000 },
      ),
      historyLimit: clampInt(advanced.historyLimit, DEFAULT_SETTINGS.advanced.historyLimit, {
        min: 5,
        max: 500,
      }),
    },
    sessionGrants: {},
  }
  for (const kind of MATERIAL_KINDS) {
    normalized.materials[kind] =
      typeof materials[kind] === 'boolean' ? materials[kind] : DEFAULT_SETTINGS.materials[kind]
  }
  // Preserve an incomplete fixed selection: it needs user input, never a
  // silent fallback to a different provider.
  // At least one material has to be sendable, and "the question" is the one that
  // makes a consultation meaningful. An all-false selection would send an empty
  // prompt and charge for it.
  if (!MATERIAL_KINDS.some((kind) => normalized.materials[kind])) {
    normalized.materials = { ...DEFAULT_SETTINGS.materials }
  }

  const now = Date.now()
  const grants = source.sessionGrants && typeof source.sessionGrants === 'object' ? source.sessionGrants : {}
  const entries = Object.entries(grants)
    .filter(([, value]) => value && typeof value === 'object' && Number.isFinite(value.at))
    .filter(([, value]) => now - value.at < GRANT_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_GRANTS)
  for (const [sessionId, value] of entries) {
    normalized.sessionGrants[sessionId] = { at: value.at }
  }
  return normalized
}

/** Path of the settings file for one profile home. */
export function settingsPath(home) {
  return join(home, 'dsh-advisor', 'settings.json')
}

/** Read settings, returning defaults for a missing or unreadable file. */
export function loadSettings(home, { readFile = readFileSync } = {}) {
  const file = settingsPath(home)
  try {
    if (!existsSync(file)) return normalizeSettings(null)
    const text = readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return normalizeSettings(parsed)
  } catch {
    return normalizeSettings(null)
  }
}

/**
 * Persist settings atomically.
 *
 * Written to a sibling temp file and renamed, because a half-written settings
 * file is worse than a missing one: JSON.parse would fail and every preference
 * would silently revert to the default, which looks like the plugin forgot.
 */
export function saveSettings(home, settings, { writeFile = writeFileSync, rename = renameSync } = {}) {
  const normalized = normalizeSettings(settings)
  const file = settingsPath(home)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  rename(temp, file)
  return normalized
}

/**
 * Apply a patch from the settings page.
 *
 * The patch is normalized together with the current values, so a page that only
 * knows about one field cannot wipe the others, and an out-of-range number is
 * reported by its corrected value rather than rejected with an error the user
 * cannot act on.
 */
export function applySettingsPatch(current, patch) {
  const base = normalizeSettings(current)
  const incoming = patch && typeof patch === 'object' ? patch : {}
  const merged = {
    ...base,
    ...incoming,
    target: { ...base.target, ...(incoming.target || {}) },
    materials: { ...base.materials, ...(incoming.materials || {}) },
    advanced: { ...base.advanced, ...(incoming.advanced || {}) },
    sessionGrants: base.sessionGrants,
  }
  return normalizeSettings(merged)
}

/**
 * Which mode actually applies to one session.
 *
 * A session grant elevates `manual` to `auto` for that session only, which is
 * what "一次授权，会话内自动使用" means. It never downgrades: a user who chose
 * `confirm` globally does not get silent consultations because a grant exists.
 */
export function effectiveMode(settings, sessionId) {
  if (settings.mode === 'auto') return 'auto'
  const grant = sessionId ? settings.sessionGrants?.[sessionId] : null
  if (grant && Number.isFinite(grant.at) && Date.now() >= grant.at && Date.now() - grant.at < GRANT_TTL_MS && settings.mode === 'manual') return 'auto'
  return settings.mode
}

/** Record "this session may consult without asking again". */
export function grantSession(settings, sessionId, at = Date.now()) {
  const next = normalizeSettings(settings)
  if (!sessionId) return next
  next.sessionGrants[sessionId] = { at }
  return next
}

/** Withdraw a grant (the user closed automatic use for this session). */
export function revokeSession(settings, sessionId) {
  const next = normalizeSettings(settings)
  if (sessionId) delete next.sessionGrants[sessionId]
  return next
}

/**
 * Resolve the provider/model one consultation will use.
 *
 * Returns `{ provider, model, source }` where source is
 *   `fixed`     — chosen in settings
 *   `session`   — the conversation's own default model
 *   `missing`   — nothing could be resolved; the caller must refuse, not guess
 */
export function resolveConsultTarget(settings, sessionSelection) {
  if (settings.target.mode === 'fixed') {
    if (!settings.target.provider || !settings.target.model) return { provider: null, model: null, source: 'missing' }
    return {
      provider: settings.target.provider,
      model: settings.target.model,
      source: 'fixed',
    }
  }
  if (sessionSelection && sessionSelection.provider && sessionSelection.model) {
    return {
      provider: sessionSelection.provider,
      model: sessionSelection.model,
      source: 'session',
    }
  }
  return { provider: null, model: null, source: 'missing' }
}

/** The profile home this plugin stores under. */
export function resolveHome(profileContext) {
  const home = profileContext && typeof profileContext.home === 'string' ? profileContext.home : null
  return home && home !== '' ? home : join(homedir(), '.dsh')
}
