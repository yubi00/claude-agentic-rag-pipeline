/**
 * Tool call limiter — enforces hard caps on WebSearch and WebFetch per session.
 *
 * Returns a hooks config for the Claude Agent SDK query() call.
 * Once any cap is hit, all further web tool calls are denied immediately
 * while RAG MCP calls (index_document, search_documents etc.) remain allowed.
 */

import { RE, R } from '../libs/ansi.js'

// Conservative defaults: keep first-pass coverage reasonable while avoiding runaway fetches.
export const DEFAULT_MAX_WEB_FETCHES = Number(process.env.MAX_WEB_FETCHES ?? 5)
export const DEFAULT_MAX_WEB_SEARCHES = Number(process.env.MAX_WEB_SEARCHES ?? 5)

const STOP_MSG = 'Research budget exhausted. Stop calling web tools immediately. Output your research summary now, using only the sources already gathered, and explicitly mention any remaining gaps.'

const deny = (reason: string) => ({
  decision: 'block' as const,
  reason,
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'deny' as const,
    permissionDecisionReason: reason,
  },
})

const allow = () => ({
  decision: 'approve' as const,
  hookSpecificOutput: { hookEventName: 'PreToolUse' as const },
})

export function makeToolLimiterHooks(options?: { maxWebFetches?: number; maxWebSearches?: number }) {
  const maxWebFetches = options?.maxWebFetches ?? DEFAULT_MAX_WEB_FETCHES
  const maxWebSearches = options?.maxWebSearches ?? DEFAULT_MAX_WEB_SEARCHES
  const counts: Record<string, number> = {}
  let hardStop = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hook = async (input: any) => {
    const tool: string = input.tool_name ?? ''

    const isWebTool = tool === 'WebFetch' || tool === 'WebSearch'
    if (hardStop && isWebTool) return deny(STOP_MSG)

    counts[tool] = (counts[tool] ?? 0) + 1

    if (tool === 'WebFetch' && counts[tool] > maxWebFetches) {
      hardStop = true
      console.log(`  ${RE}[LIMIT] WebFetch cap (${maxWebFetches}) reached — hard stop${R}`)
      return deny(STOP_MSG)
    }

    if (tool === 'WebSearch' && counts[tool] > maxWebSearches) {
      hardStop = true
      console.log(`  ${RE}[LIMIT] WebSearch cap (${maxWebSearches}) reached — hard stop${R}`)
      return deny(STOP_MSG)
    }

    return allow()
  }

  return { PreToolUse: [{ hooks: [hook] }] }
}
