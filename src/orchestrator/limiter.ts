/**
 * Tool call limiter — enforces hard caps on WebSearch and WebFetch per session.
 *
 * Returns a hooks config for the Claude Agent SDK query() call.
 * Once any cap is hit, all further web tool calls are denied immediately
 * while RAG MCP calls (index_document, search_documents etc.) remain allowed.
 */

import { RE, R } from '../libs/ansi.js'

export const MAX_WEB_FETCHES = 4   // per session
export const MAX_WEB_SEARCHES = 4  // per session

const STOP_MSG = 'Research budget exhausted. OUTPUT YOUR RESEARCH SUMMARY NOW. Do not call any more tools.'

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

export function makeToolLimiterHooks() {
  const counts: Record<string, number> = {}
  let hardStop = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hook = async (input: any) => {
    const tool: string = input.tool_name ?? ''

    const isWebTool = tool === 'WebFetch' || tool === 'WebSearch'
    if (hardStop && isWebTool) return deny(STOP_MSG)

    counts[tool] = (counts[tool] ?? 0) + 1

    if (tool === 'WebFetch' && counts[tool] > MAX_WEB_FETCHES) {
      hardStop = true
      console.log(`  ${RE}[LIMIT] WebFetch cap (${MAX_WEB_FETCHES}) reached — hard stop${R}`)
      return deny(STOP_MSG)
    }

    if (tool === 'WebSearch' && counts[tool] > MAX_WEB_SEARCHES) {
      hardStop = true
      console.log(`  ${RE}[LIMIT] WebSearch cap (${MAX_WEB_SEARCHES}) reached — hard stop${R}`)
      return deny(STOP_MSG)
    }

    return allow()
  }

  return { PreToolUse: [{ hooks: [hook] }] }
}
