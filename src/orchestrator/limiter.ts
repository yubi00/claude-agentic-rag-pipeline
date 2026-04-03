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

interface ToolLimiterOptions {
  maxWebFetches?: number
  maxWebSearches?: number
}

interface HookDecision {
  decision: 'approve' | 'block'
  reason?: string
  hookSpecificOutput: {
    hookEventName: 'PreToolUse'
    permissionDecision?: 'deny'
    permissionDecisionReason?: string
  }
}

const deny = (reason: string): HookDecision => ({
  decision: 'block' as const,
  reason,
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'deny' as const,
    permissionDecisionReason: reason,
  },
})

const allow = (): HookDecision => ({
  decision: 'approve' as const,
  hookSpecificOutput: { hookEventName: 'PreToolUse' as const },
})

export function makeToolLimiterHooks(options?: ToolLimiterOptions) {
  const maxWebFetches = options?.maxWebFetches ?? DEFAULT_MAX_WEB_FETCHES
  const maxWebSearches = options?.maxWebSearches ?? DEFAULT_MAX_WEB_SEARCHES
  const counts: Record<string, number> = {}
  let hardStop = false

  const hook = async (input: unknown): Promise<HookDecision> => {
    const tool = getToolName(input)

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

function getToolName(input: unknown): string {
  if (!input || typeof input !== 'object') return ''

  const value = (input as Record<string, unknown>).tool_name
  return typeof value === 'string' ? value : ''
}
