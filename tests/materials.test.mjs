/**
 * The materials one consultation carries.
 *
 * The case that motivated most of this file: a real consultation sent a todo
 * list written two tasks earlier under the heading "当前方案", and the advisor
 * spent 1207 characters reviewing the wrong project. It had no way to tell, and
 * neither did the user, because nothing in the request said how old the material
 * was. Age is now part of the material.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BUDGET, collectMaterials, describeMaterials } from '../lib/materials.js'

const ALL_ON = {
  materials: { question: true, selection: true, plan: true, diff: true, test: true },
}

const QUESTION = { question: '这个方案有什么问题？' }

function sessionOf(events) {
  return { snapshotEvents: () => events }
}

function turnAt(seq) {
  return { type: 'turn/start', seq, data: { turn: 1 } }
}

function todosAt(seq, todos) {
  return { type: 'todo/write', seq, data: { todos } }
}

function saidAt(seq, text) {
  return { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
}

async function collect(events, request = QUESTION, settings = ALL_ON) {
  return collectMaterials({
    settings,
    session: sessionOf(events),
    sessionId: 'session-test',
    request,
    workspaceChanges: null,
    signal: undefined,
    cwd: null,
  })
}

function material(result, kind) {
  return result.materials.find((entry) => entry.kind === kind)
}

test('a todo list written this turn is the current plan', async () => {
  const result = await collect([
    turnAt(10),
    todosAt(11, [{ content: '写验收脚本', status: 'in_progress' }]),
    saidAt(12, '先冻结验收，再改实现。'),
  ])
  const plan = material(result, 'plan')
  assert.equal(plan.absent, undefined)
  assert.equal(plan.fromEarlierTurn, false)
  assert.match(plan.text, /^当前方案：/u)
  assert.match(plan.text, /待办事项：\n- \[in_progress\] 写验收脚本/u)
  assert.match(plan.text, /主力最近一次说明：\n先冻结验收，再改实现。/u)
})

test('a todo list from an earlier turn is not presented as the current plan', async () => {
  const result = await collect([
    turnAt(10),
    todosAt(11, [{ content: '旧任务 A', status: 'completed' }]),
    saidAt(12, '旧任务的说明。'),
    turnAt(50),
  ])
  const plan = material(result, 'plan')
  assert.equal(plan.fromEarlierTurn, true)
  assert.match(plan.text, /^最近记录的方案（本轮还没有新的方案）：/u)
  assert.match(plan.text, /待办事项（写于更早的轮次，可能已完成或已作废）：/u)
  assert.match(plan.text, /主力最近一次说明（写于更早的轮次）：/u)
})

test('a turn with no plan at all reports the material as absent', async () => {
  const result = await collect([turnAt(10)])
  const plan = material(result, 'plan')
  assert.equal(plan.absent, true)
  assert.equal(plan.chars, 0)
  assert.equal(plan.reason, 'this turn has not written a plan or a statement yet')
  assert.equal(result.text.includes('当前方案'), false)
})

test('a current statement keeps the plan usable when the todo list is old', async () => {
  const result = await collect([
    turnAt(10),
    todosAt(11, [{ content: '旧待办', status: 'pending' }]),
    turnAt(50),
    saidAt(51, '本轮的新说明。'),
  ])
  const plan = material(result, 'plan')
  // Any stale half marks the material: the user is still being shown work that
  // predates this turn, so the warning applies even though half of it is fresh.
  assert.equal(plan.fromEarlierTurn, true)
  assert.match(plan.text, /待办事项（写于更早的轮次/u)
  assert.match(plan.text, /主力最近一次说明：\n本轮的新说明。/u)
})

test('a log without turn markers falls back to the most recent events', async () => {
  const result = await collect([todosAt(11, [{ content: '旧待办', status: 'pending' }])])
  const plan = material(result, 'plan')
  assert.equal(plan.fromEarlierTurn, false)
  assert.match(plan.text, /^当前方案：/u)
})

test('the preview line says when a material predates this turn', async () => {
  assert.equal(
    describeMaterials([{ label: '当前方案', chars: 120, fromEarlierTurn: true }]),
    '当前方案 120 字（写于更早的轮次）',
  )
  assert.equal(describeMaterials([{ label: '当前方案', chars: 120 }]), '当前方案 120 字')
  assert.equal(
    describeMaterials([{ label: '当前方案', chars: 0, absent: true, fromEarlierTurn: true }]),
    '',
  )
})

test('a plan over its budget is truncated and the request says so', async () => {
  const long = '很长的方案说明。'.repeat(1000)
  const result = await collect([turnAt(10), saidAt(11, long)])
  const plan = material(result, 'plan')
  assert.equal(plan.truncated, true)
  assert.equal(plan.chars, BUDGET.plan)
  assert.match(result.text, /（以上内容因长度限制被截断）/u)
})

test('the same events produce the same text and the same digest', async () => {
  const events = [turnAt(10), saidAt(11, '同一段说明。')]
  const first = await collect(events)
  const second = await collect(events)
  assert.equal(first.text, second.text)
  assert.equal(first.digest, second.digest)
})

test('an empty question refuses before anything is assembled', async () => {
  const result = await collect([turnAt(10)], { question: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty-question')
  assert.equal(result.chars, 0)
  assert.deepEqual(result.materials, [])
})

test('materials that cannot be read are absent with a reason, not silently empty', async () => {
  const result = await collect([turnAt(10)], { question: '看看' })
  const diff = material(result, 'diff')
  assert.equal(diff.absent, true)
  assert.equal(diff.reason, 'the host does not expose workspace changes')
  const failing = material(result, 'test')
  assert.equal(failing.absent, true)
  assert.equal(failing.reason, 'this session has no failed tool call or recognized test summary to show')
})

test('a material disabled in settings is not collected even when the client asks', async () => {
  const settings = {
    materials: { question: true, selection: true, plan: false, diff: false, test: false },
  }
  const result = await collect([turnAt(10), saidAt(11, '说明')], QUESTION, settings)
  assert.equal(material(result, 'plan'), undefined)
})

test('an explicit opt-out from the client wins over the setting', async () => {
  const result = await collect([turnAt(10), saidAt(11, '说明')], {
    question: '看看',
    materials: { plan: false },
  })
  assert.equal(material(result, 'plan'), undefined)
})

test('a selection carries the place it came from', async () => {
  const result = await collect([turnAt(10)], {
    question: '看看',
    selection: { text: 'const a = 1', path: 'src/a.js', startLine: 3, endLine: 4 },
  })
  const selection = material(result, 'selection')
  assert.match(selection.text, /^选中内容（src\/a\.js，第 3-4 行）：\nconst a = 1/u)
  assert.equal(selection.path, 'src/a.js')
})
