import { createRequire } from 'node:module'
import { join } from 'node:path'
const local = createRequire(import.meta.url)
// Optional paths let CI reuse preinstalled dependencies without changing source.
export function resolve(name) {
  try { return local.resolve(name) } catch (original) {
    for (const dir of [process.env.DSH_UI_NODE_MODULES, process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean)) {
      try { return createRequire(join(dir, '_resolver.cjs')).resolve(name) } catch {}
    }
    throw original
  }
}
export const dependency = name => local(resolve(name))
