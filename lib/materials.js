/**
 * dsh-advisor v0.2 — what a consultation is allowed to send.
 *
 * Every material is assembled from something the session already recorded, and
 * the user sees the assembled text BEFORE it leaves the machine. That ordering
 * is the whole point: an advisor that quietly attaches the conversation is a
 * privacy incident with a nice UI, and an advisor whose scope cannot be stated
 * in a sentence cannot be trusted with a code review.
 *
 * Three rules shaped this file:
 *
 * 1. Nothing is inferred into the request. If a material could not be read, it
 *    is reported as absent with the reason, not replaced by a plausible guess.
 *    "No test output because no test ran" and "no test output because I could
 *    not find it" are different facts and the user needs the second one.
 *
 * 2. Every material carries its own budget. A single global cap would let one
 *    huge diff crowd out the question that the user actually asked, which
 *    inverts the consultation.
 *
 * 3. The assembled text is deterministic for a given material version. The
 *    preview the user approved and the request that is sent must be the same
 *    bytes; a digest over the assembled text is what proves it, so a session
 *    that kept writing while the user read the preview cannot smuggle new
 *    content into an approved request.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

import { MATERIAL_KINDS, MATERIAL_LABELS } from './settings.js'

/** Presentation order, and the order materials are concatenated in. */
export const ORDER = ['question', 'selection', 'plan', 'diff', 'test']

/** Per-material ceilings. Together they bound one request at ~16k characters. */
export const BUDGET = {
  question: 4000,
  selection: 6000,
  plan: 4000,
  diff: 6000,
  test: 3000,
}

/** Files whose digest is worth remembering: the ones whose text was sent. */
const MAX_DIGEST_FILES = 40
const MAX_DIGEST_BYTES = 2 * 1024 * 1024

function clampText(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

/** A digest of one file's bytes, or null when it cannot be read cheaply. */
export function fileDigest(path) {
  if (typeof path !== 'string' || path === '') return null
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > MAX_DIGEST_BYTES) return null
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 32)}`
  } catch {
    return null
  }
}

/** Digest map for one set of paths, bounded in count. */
export function digestFiles(paths) {
  const out = {}
  for (const path of paths.slice(0, MAX_DIGEST_FILES)) {
    const digest = fileDigest(path)
    if (digest) out[path] = digest
  }
  return out
}

/**
 * Read the events a material needs without subscribing to the session.
 *
 * `session.snapshotEvents()` is the durable log, so this is the same data the
 * UI renders — not a plugin-side cache that can drift from it.
 */
function events(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return []
    const all = session.snapshotEvents()
    return Array.isArray(all) ? all : []
  } catch {
    return []
  }
}

/** Text of one message content array, ignoring non-text blocks. */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Where the current turn starts, or null when the log does not say.
 *
 * The session log spans every turn the session has ever run, so "the most
 * recent event of this type" is not the same thing as "what this turn is
 * doing". A todo list written two tasks ago is still the most recent
 * `todo/write` in the file. Anchoring to the last `turn/start` is the only
 * thing that tells those two cases apart.
 */
function currentTurnSeq(all) {
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]
    if (event && event.type === 'turn/start' && Number.isFinite(event.seq)) return event.seq
  }
  return null
}

/**
 * The plan in front of the model right now: its current statement plus the todo
 * list it is working from.
 *
 * Both halves matter. The message says what the model claims it is doing; the
 * todo list says what it committed to. A consultation that sees only the first
 * cannot notice a task the model quietly dropped.
 *
 * Both halves are also dated. Sending a finished task's todo list under the
 * heading "current plan" is worse than sending nothing, because the advisor
 * reviews the wrong work and the user is never told: that is exactly the
 * failure this anchor exists to prevent. Material from an earlier turn is still
 * sent — it is often the only thing there is — but it says so, and the flag
 * travels with it so the preview and the record can repeat the warning.
 */
function collectPlan(session) {
  const all = events(session)
  const turnSeq = currentTurnSeq(all)
  const inTurn = (seq) => turnSeq === null || !Number.isFinite(seq) || seq > turnSeq

  let lastAssistant = ''
  let messageSeq = null
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]
    if (event && event.type === 'assistant/message' && event.data && event.data.message) {
      const text = messageText(event.data.message.content)
      if (text.trim() !== '') {
        lastAssistant = text
        messageSeq = event.seq
        break
      }
    }
  }
  let todos = []
  let todoSeq = null
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]
    if (event && event.type === 'todo/write' && event.data && Array.isArray(event.data.todos)) {
      todos = event.data.todos
      todoSeq = event.seq
      break
    }
  }

  const todosCurrent = inTurn(todoSeq)
  const messageCurrent = inTurn(messageSeq)
  const lines = []
  if (todos.length > 0) {
    lines.push(todosCurrent ? '待办事项：' : '待办事项（写于更早的轮次，可能已完成或已作废）：')
    for (const todo of todos.slice(0, 30)) {
      const mark = todo && typeof todo.status === 'string' ? todo.status : 'pending'
      const text = todo && typeof todo.content === 'string' ? todo.content : ''
      if (text !== '') lines.push(`- [${mark}] ${text}`)
    }
    lines.push('')
  }
  if (lastAssistant !== '') {
    lines.push(messageCurrent ? '主力最近一次说明：' : '主力最近一次说明（写于更早的轮次）：')
    lines.push(lastAssistant)
  }
  return {
    text: lines.join('\n').trim(),
    hasTodos: todos.length > 0,
    hasMessage: lastAssistant !== '',
    // True when any included half predates this turn. Both halves stale is the
    // case that used to arrive disguised as the current plan.
    fromEarlierTurn: (todos.length > 0 && !todosCurrent) || (lastAssistant !== '' && !messageCurrent),
  }
}

/**
 * The changed files of the most recent completed turn, with a bounded diff.
 *
 * The diff comes from `workspaceChanges`, which the host builds at turn
 * boundaries. This plugin never runs git itself: a second implementation would
 * disagree with what the user sees in the deliverable panel, and disagreeing
 * about "what changed" makes a review worthless.
 */
async function collectDiff({ session, sessionId, workspaceChanges, maxFiles = 6, signal }) {
  if (!workspaceChanges || typeof workspaceChanges.summary !== 'function') {
    return { text: '', reason: 'the host does not expose workspace changes', paths: [] }
  }
  const all = events(session)
  let changeSeq = null
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]
    if (event && event.type === 'workspace/changes') {
      changeSeq = event.seq
      break
    }
  }
  if (changeSeq === null) {
    return { text: '', reason: 'this session has no recorded workspace changes yet', paths: [] }
  }
  let summary = null
  try {
    summary = workspaceChanges.summary(sessionId, changeSeq)
  } catch {
    summary = null
  }
  if (!summary) {
    return { text: '', reason: 'the change summary for that turn is no longer available', paths: [] }
  }
  const files = Array.isArray(summary.files) ? summary.files : []
  const lines = [`第 ${summary.turn} 轮改动：${summary.total} 个文件，+${summary.added} / -${summary.deleted}`]
  for (const file of files.slice(0, 40)) {
    const display = file && typeof file.display === 'string' ? file.display : String(file && file.path)
    lines.push(`- ${display} (+${file.added} / -${file.deleted})`)
  }
  if (files.length > 40) lines.push(`- …另有 ${files.length - 40} 个文件`)
  const paths = files.map((file) => (file && typeof file.path === 'string' ? file.path : '')).filter((p) => p !== '')

  // A file list is a table of contents, not a diff. Reviewing a change needs the
  // actual hunks, so the first few readable files are included.
  let budgetLeft = Math.floor(BUDGET.diff * 0.6)
  for (let index = 0; index < Math.min(files.length, maxFiles) && budgetLeft > 200; index += 1) {
    let comparison = null
    try {
      comparison = await workspaceChanges.diff(sessionId, changeSeq, index, signal)
    } catch {
      comparison = null
    }
    if (!comparison) continue
    const display = typeof comparison.display === 'string' ? comparison.display : `file ${index}`
    if (comparison.kind !== 'text') {
      lines.push('', `--- ${display}：${comparison.kind}，无法展示行级差异`)
      continue
    }
    const hunks = Array.isArray(comparison.hunks) ? comparison.hunks : []
    const body = hunks
      .map((hunk) => {
        const head = `@@ -${hunk.beforeStart}+${hunk.afterStart} @@`
        const rows = (Array.isArray(hunk.lines) ? hunk.lines : [])
          .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
          .join('\n')
        return `${head}\n${rows}`
      })
      .join('\n')
    const clipped = clampText(body, Math.min(budgetLeft, 2400))
    lines.push('', `--- ${display}`, clipped.text)
    if (clipped.truncated) lines.push('(该文件差异已截断)')
    budgetLeft -= clipped.text.length
  }
  return { text: lines.join('\n'), reason: null, paths, changeCount: summary.total, changeSeq }
}

/**
 * The most recent failed tool result.
 *
 * A consultation about a failing test is only useful if it can see the failure,
 * so the output is included — but it is the TOOL's output, not the model's
 * retelling of it, because a model narrating its own failure tends to explain it
 * away.
 */
function collectTest(session) {
  const all = events(session)
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]
    if (!event || event.type !== 'tool/result') continue
    const data = event.data || {}
    const failed = data.error !== undefined || (data.message && data.message.isError === true)
    if (!failed) continue
    const text = data.message ? messageText(data.message.content) : ''
    const name = data.message && data.message.source && data.message.source.kind === 'tool' ? '工具' : '工具'
    const callId = data.message && data.message.toolCallId ? data.message.toolCallId : ''
    const lines = [`${name}调用失败（${callId}）：`]
    const clipped = clampText(text, BUDGET.test - 200)
    lines.push(clipped.text)
    if (clipped.truncated) lines.push('(输出已截断)')
    return { text: lines.join('\n'), callId, found: true }
  }
  return { text: '', found: false }
}

/**
 * Assemble the materials one consultation may carry.
 *
 * `request` is what the client asked for; `settings` decides what is allowed.
 * The intersection is what gets sent, and both halves are reported back so the
 * UI can say "you allowed diffs, but this session has none" instead of silently
 * dropping the material.
 */
export async function collectMaterials({
  settings,
  session,
  sessionId,
  request,
  workspaceChanges = null,
  signal,
  cwd = null,
}) {
  const wanted = {}
  for (const kind of MATERIAL_KINDS) {
    const requested = request && request.materials && request.materials[kind]
    wanted[kind] = Boolean(settings.materials[kind] && requested !== false)
  }
  const materials = []
  const digestPaths = []
  let changeCount = null
  let changeToken = null

  const push = (kind, text, extra = {}) => {
    const clipped = clampText(text, BUDGET[kind])
    materials.push({
      kind,
      label: MATERIAL_LABELS[kind],
      text: clipped.text,
      chars: clipped.text.length,
      truncated: clipped.truncated,
      ...extra,
    })
  }

  // The question is the one material that cannot be empty: without it the
  // request would carry only attachments, and the advisor would have to guess
  // what to look at.
  const question = typeof (request && request.question) === 'string' ? request.question.trim() : ''
  if (question === '') {
    return { ok: false, reason: 'empty-question', materials: [], text: '', chars: 0 }
  }
  push('question', question)

  if (wanted.selection) {
    const selection = request && request.selection ? request.selection : null
    const text = selection && typeof selection.text === 'string' ? selection.text.trim() : ''
    if (text !== '') {
      const where = []
      if (selection.path) where.push(selection.path)
      if (Number.isFinite(selection.startLine) && Number.isFinite(selection.endLine)) {
        where.push(`第 ${selection.startLine}-${selection.endLine} 行`)
      }
      const header = where.length > 0 ? `选中内容（${where.join('，')}）：` : '选中内容：'
      push('selection', `${header}\n${text}`, { path: selection.path || null })
      if (selection.path) digestPaths.push(selection.path)
    }
  }

  if (wanted.plan) {
    const plan = collectPlan(session)
    if (plan.text !== '') {
      const header = plan.fromEarlierTurn ? '最近记录的方案（本轮还没有新的方案）：' : '当前方案：'
      push('plan', `${header}\n${plan.text}`, {
        hasTodos: plan.hasTodos,
        fromEarlierTurn: plan.fromEarlierTurn,
      })
    } else {
      // Rule 1: say the material is missing and why. A finished task's todo list
      // is not a substitute for a plan that has not been written yet.
      materials.push({
        kind: 'plan',
        label: MATERIAL_LABELS.plan,
        text: '',
        chars: 0,
        truncated: false,
        absent: true,
        reason: 'this turn has not written a plan or a statement yet',
      })
    }
  }

  if (wanted.diff) {
    const diff = await collectDiff({ session, sessionId, workspaceChanges, signal })
    if (diff.text !== '') {
      push('diff', `当前改动：\n${diff.text}`, { reason: null })
      changeCount = Number.isFinite(diff.changeCount) ? diff.changeCount : null
      changeToken = diff.changeSeq !== null && diff.changeSeq !== undefined ? `seq:${diff.changeSeq}` : null
      if (cwd) {
        for (const path of diff.paths) digestPaths.push(joinIfRelative(cwd, path))
      }
    } else {
      materials.push({
        kind: 'diff',
        label: MATERIAL_LABELS.diff,
        text: '',
        chars: 0,
        truncated: false,
        absent: true,
        reason: diff.reason || 'no changes to show',
      })
    }
  }

  if (wanted.test) {
    const test = collectTest(session)
    if (test.found) push('test', `测试失败：\n${test.text}`, { callId: test.callId })
    else {
      materials.push({
        kind: 'test',
        label: MATERIAL_LABELS.test,
        text: '',
        chars: 0,
        truncated: false,
        absent: true,
        reason: 'this session has no failed tool call to show',
      })
    }
  }

  const text = renderMaterials(materials, request)
  return {
    ok: true,
    materials,
    text,
    chars: text.length,
    digest: digestText(text),
    files: digestFiles(digestPaths),
    changeCount,
    changeToken,
  }
}

function joinIfRelative(cwd, path) {
  if (typeof path !== 'string' || path === '') return path
  if (/^([A-Za-z]:[\\/]|\/)/.test(path)) return path
  const base = String(cwd).replace(/[\\/]+$/, '')
  return `${base}/${path.replace(/^[.][\\/]/, '')}`
}

/** Concatenate materials into the exact text that will be sent. */
export function renderMaterials(materials, request) {
  const focus = request && typeof request.focus === 'string' ? request.focus : 'general'
  const lines = []
  for (const material of materials) {
    if (material.absent || material.chars === 0) continue
    lines.push(`## ${material.label}`)
    lines.push(material.text)
    if (material.truncated) lines.push('（以上内容因长度限制被截断）')
    lines.push('')
  }
  const body = lines.join('\n').trim()
  return `关注类型：${focus}\n\n${body}`
}

export function digestText(text) {
  return `sha256:${createHash('sha256').update(String(text)).digest('hex').slice(0, 32)}`
}

/**
 * A one-line description of what a consultation is about to send.
 *
 * Used by the confirmation area and by the result card, so the two can never
 * describe the same request differently.
 */
export function describeMaterials(materials) {
  const sent = materials.filter((material) => !material.absent && material.chars > 0)
  return sent
    .map((material) => {
      const dated = material.fromEarlierTurn ? '（写于更早的轮次）' : ''
      return `${material.label} ${material.chars} 字${dated}`
    })
    .join('、')
}
