/** Runs the actual plugin and RPC handlers, with simulated DSH slots and LLM.
 * Loopback only. No provider credentials, remote calls or user history are used.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHost } from '../../lib/host.js'
import { rpcHandler } from '../../lib/rpc.js'
import { openHistory } from '../../lib/history.js'
import { makeFakeLlm } from '../../tests/helpers.mjs'
import { resolve } from './dependencies.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const here = dirname(fileURLToPath(import.meta.url))
export async function startHarness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ui-'))
  const calls = [], deliveries = []
  const llm = makeFakeLlm({ text: '建议先补充空列表的回归用例。\n\n当前流程对正常输入有覆盖，但取消后立即重试的路径还需要验证。请检查请求状态是否复位，再确认不会重复提交。' })
  llm.listProviders = async () => [{ id: 'deepseek', label: 'DeepSeek' }, { id: 'review-provider', label: 'Review provider' }]
  llm.listModels = async id => id === 'deepseek' ? [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] : [{ id: 'review-model', name: 'Review Model' }]
  const session = { cwd: null, snapshotEvents: () => [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'todo/write', seq: 2, data: { todos: [{ content: '检查空列表与取消后重试的行为', status: 'in_progress' }] } },
  ] }
  const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    agents: { get: () => ({ followup: async payload => { deliveries.push(payload) } }) } }
  const host = createHost({ ctx: { get: key => services[key] }, home, getSession: () => session })
  host.persist({ ...host.settings(), materials: { question: true, selection: true, plan: true, diff: true, test: true } })
  const history = openHistory(home, 'demo')
  const fixtures = [
    { id: 'old', question: '取消后再次提交，会不会发出重复请求？', state: 'returned', advice: '建议在请求开始时同步锁定按钮。\n\n仅使用异步状态更新可能在快速点击时留下窗口；取消完成后应释放锁，并保留用户输入以便重试。' },
    { id: 'fixed', question: '空列表的边界处理是否完整？', state: 'returned', advice: '空列表需要独立的空态和明确的下一步。', verification: 'confirmed', disposition: 'fixed', verdictNote: '已补充空列表测试，并确认入口可用。' },
    { id: 'failed', question: '请检查最新测试结果', state: 'failed', error: { code: 'fixture', message: '模拟供应商暂时不可用，请稍后重试。' } },
    { id: 'recent', question: '这次设置保存流程还有哪些遗漏？', state: 'returned', advice: '建议明确区分设置草稿与已生效配置。\n\n1. 用户切换模型后，应看到未保存状态。\n2. 连接检查应使用已保存的模型。\n3. 放弃修改时，应恢复上一次保存的值。\n\n完成修改后，建议同时验证窄窗口与键盘操作。' },
  ]
  fixtures.forEach((record, i) => history.put({ createdAt: new Date(Date.UTC(2026, 9, 29, 9, i * 6)).toISOString(),
    settledAt: new Date(Date.UTC(2026, 9, 29, 9, i * 6, 15)).toISOString(), sessionId: 'demo',
    target: { provider: 'review-provider', model: 'review-model', source: 'fixed' },
    materials: { kinds: ['question', 'plan'], chars: 438 }, ...record }))
  const rpc = rpcHandler('/plugin/dsh-advisor', async (method, params) => {
    calls.push({ method, params })
    if (!host.handlers[method]) throw new Error('Unknown method')
    return host.handlers[method](params)
  })
  const assets = {
    '/': [join(here, 'harness.html'), 'text/html; charset=utf-8'],
    '/client.js': [join(root, 'client/client.js'), 'text/javascript'],
    '/react.js': [join(dirname(resolve('react/package.json')), 'umd/react.development.js'), 'text/javascript'],
    '/react-dom.js': [join(dirname(resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'text/javascript'],
    '/fonts.css': [join(dirname(resolve('@fontsource/noto-sans-sc/package.json')), '400.css'), 'text/css'],
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.startsWith('/plugin/dsh-advisor/')) return rpc(req, res)
    let asset = assets[path]
    if (/^\/files\/[\w.-]+\.woff2?$/.test(path)) asset = [join(dirname(resolve('@fontsource/noto-sans-sc/package.json')), path.slice(1)), 'font/woff2']
    if (asset) { res.setHeader('Content-Type', asset[1]); return res.end(readFileSync(asset[0])) }
    res.statusCode = 404; res.end('Not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, host, llm, calls, deliveries,
    close: async () => { host.abortAll(); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }) } }
}
if (process.argv.includes('--serve')) {
  const harness = await startHarness()
  console.log(`Local fixture preview: ${harness.url}`)
  process.on('SIGINT', async () => { await harness.close(); process.exit(0) })
}
