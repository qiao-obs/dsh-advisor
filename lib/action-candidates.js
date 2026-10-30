/** Optional structured suggestions are data, never executable instructions. */
const fields = { title: 160, action: 2000, acceptance: 2000, evidence: 2000 }
export function normalizeCandidates(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 3).flatMap(raw => {
    if (!raw || typeof raw !== 'object') return []
    const candidate = {}
    for (const [key, limit] of Object.entries(fields)) {
      if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > limit) return []
      candidate[key] = raw[key].trim()
    }
    candidate.priority = ['high', 'normal', 'low'].includes(raw.priority) ? raw.priority : 'normal'
    return [candidate]
  })
}
export function parseCandidates(text, state) {
  if (state !== 'returned' || typeof text !== 'string') return []
  const match = /```advisor-actions\s*\n([\s\S]*?)\n```/.exec(text)
  if (!match) return []
  try { return normalizeCandidates(JSON.parse(match[1])) } catch { return [] }
}
export const ACTION_PROMPT = [
  'When there are concrete actionable findings, end with one optional ```advisor-actions fenced JSON array (at most 3 items).',
  'Each item: {"title":"short goal","priority":"high|normal|low","evidence":"specific supplied evidence or explicitly unknown","action":"smallest bounded next action","acceptance":"observable check and expected result"}.',
  'Keep prose and JSON concise within the token limit. Use the requested response language for field values.',
  'These are suggestions for human review, not authorizations. Never mark work done, invent test results, or include shell commands as automatic actions.',
  'If evidence is insufficient, suggest a concrete investigation with a checkable output. If there is no useful action, omit the block. NO_ADVICE stays valid.',
].join('\n')
