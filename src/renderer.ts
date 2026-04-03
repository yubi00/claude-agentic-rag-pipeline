/**
 * Stream renderer — pretty-prints SDKMessage events to stdout.
 *
 * Organised as a Renderer class with a handler dispatch map.
 * Each message type gets its own handler method — no monolithic if/else chain.
 * Agent text extraction and RAG result parsing are separate private methods.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any

import { R, B, D, CY, GR, YE, MA, RE, BL, AGENT_COLORS } from './ansi.js'
import { printLines, extractText } from './utils.js'
import { AGENT_FORMATTERS } from './agentFormatters.js'

// ── RAG result rendering ──────────────────────────────────────────────────────

function renderRagResult(toolName: string, resultText: string): void {
  const shortName = toolName.replace('mcp__rag__', '')
  try {
    const parsed = JSON.parse(resultText)
    if (shortName === 'search_documents') {
      const count: number = parsed.resultCount ?? 0
      const query: string = parsed.query ?? ''
      if (count === 0) {
        console.log(`  ${RE}[RAG:search ◀]${R} ${D}no results for: "${query}"${R}`)
      } else {
        const scores = (parsed.results ?? []).map((r: Msg) => r.score?.toFixed(2)).join(', ')
        console.log(`  ${GR}[RAG:search ◀]${R} ${D}"${query}" → ${count} result(s) | scores: [${scores}]${R}`)
      }
    } else if (shortName === 'index_document') {
      console.log(`  ${BL}[RAG:index  ◀]${R} ${D}doc #${parsed.documentId ?? '?'} "${parsed.title ?? ''}" (${parsed.contentLength ?? 0} chars)${R}`)
    } else if (shortName === 'list_indexed') {
      console.log(`  ${BL}[RAG:list   ◀]${R} ${D}${parsed.totalDocuments ?? 0} document(s) in knowledge base${R}`)
    } else if (shortName === 'clear_index') {
      console.log(`  ${YE}[RAG:clear  ◀]${R} ${D}knowledge base cleared${R}`)
    }
  } catch {
    console.log(`  ${GR}[RAG:${shortName} ◀]${R} ${D}${resultText.slice(0, 120)}${R}`)
  }
}

// ── Renderer class ────────────────────────────────────────────────────────────

class Renderer {
  // Maps tool_use_id → agent name for labelling subagent messages
  private readonly agentByToolUseId = new Map<string, string>()
  // Maps agent name → call count (for iteration labels)
  private readonly agentIterations: Record<string, number> = {}

  // ── Handler dispatch map ─────────────────────────────────────────────────

  private readonly handlers: Record<string, (msg: Msg) => void> = {
    system:           (msg) => this.handleSystem(msg),
    assistant:        (msg) => this.handleAssistant(msg),
    tool_progress:    (msg) => this.handleToolProgress(msg),
    tool_result:      (msg) => this.handleToolResult(msg),
    result:           (msg) => this.handleResult(msg),
    rate_limit_event: (msg) => this.handleRateLimit(msg),
  }

  render(msg: Msg): void {
    this.handlers[msg?.type ?? '']?.(msg)
  }

  // ── System messages ──────────────────────────────────────────────────────

  private handleSystem(msg: Msg): void {
    const subtypeHandlers: Record<string, (msg: Msg) => void> = {
      init:              (m) => this.handleInit(m),
      task_started:      (m) => this.handleTaskStarted(m),
      task_progress:     (m) => this.handleTaskProgress(m),
      task_notification: ()  => console.log(`  ${D}[agent done]${R}`),
    }
    subtypeHandlers[msg.subtype ?? '']?.(msg)
  }

  private handleInit(msg: Msg): void {
    const sid: string = msg.session_id ?? 'unknown'
    const model: string = msg.model ?? 'unknown'
    const tools: string[] = msg.tools ?? []
    console.log(`\n${B}${CY}[SESSION]${R} ${sid.slice(0, 20)}… | model: ${model}`)
    if (tools.length) console.log(`${D}  tools: ${tools.join(', ')}${R}`)
    console.log()
  }

  private handleTaskStarted(msg: Msg): void {
    const desc: string = msg.description ?? msg.task_description ?? ''
    console.log(`\n${B}${YE}[AGENT STARTED]${R} ${desc}`)
  }

  private handleTaskProgress(msg: Msg): void {
    const u = msg.usage ?? msg.cumulative_usage ?? {}
    const tools = u.tool_uses ?? u.toolUses ?? '?'
    const tokens = u.total_tokens ?? u.totalTokens ?? '?'
    const ms = u.duration_ms ?? u.durationMs ?? 0
    console.log(`  ${D}[progress] ${tools} tool calls | ${tokens} tokens | ${(ms / 1000).toFixed(1)}s${R}`)
    if (msg.summary) console.log(`  ${D}[summary] ${msg.summary}${R}`)
  }

  // ── Assistant messages ───────────────────────────────────────────────────

  private handleAssistant(msg: Msg): void {
    const parentId: string | undefined = msg.parent_tool_use_id
    const isSubagent = !!parentId
    const agentName = parentId ? (this.agentByToolUseId.get(parentId) ?? 'subagent') : 'orchestrator'
    const blocks: Msg[] = msg.message?.content ?? []

    for (const block of blocks) {
      const bt: string = block.type ?? ''
      if (bt === 'thinking')  this.handleThinkingBlock(block, isSubagent)
      if (bt === 'text')      this.handleTextBlock(block, isSubagent, agentName)
      if (bt === 'tool_use')  this.handleToolUseBlock(block, isSubagent, agentName)
    }
  }

  private handleThinkingBlock(block: Msg, isSubagent: boolean): void {
    if (isSubagent) return  // suppress subagent thinking — too verbose
    const preview = ((block.thinking as string) ?? '').replace(/\n/g, ' ').slice(0, 200)
    console.log(`  ${D}[thinking] ${preview}…${R}`)
  }

  private handleTextBlock(block: Msg, isSubagent: boolean, agentName: string): void {
    const text: string = (block.text as string) ?? ''
    if (!text.trim()) return

    if (!isSubagent) {
      printLines(CY, '[ORCHESTRATOR]', text, 400)
      return
    }

    const renderer = AGENT_FORMATTERS[agentName]
    if (renderer) {
      renderer(text)
    } else {
      printLines(AGENT_COLORS[agentName] ?? D, `  [${agentName}]`, text, 600)
    }
  }

  private handleToolUseBlock(block: Msg, isSubagent: boolean, agentName: string): void {
    const toolName: string = (block.name as string) ?? ''

    if (toolName === 'Agent' || toolName === 'Task') {
      this.handleAgentCall(block)
    } else if (isSubagent) {
      this.handleSubagentToolCall(toolName, block.input ?? {}, agentName)
    }
  }

  private handleAgentCall(block: Msg): void {
    const inp = block.input as Msg
    const agentType: string = inp?.subagent_type ?? inp?.agentType ?? 'unknown'
    if (block.id) this.agentByToolUseId.set(block.id, agentType)
    this.agentIterations[agentType] = (this.agentIterations[agentType] ?? 0) + 1
    const iter = this.agentIterations[agentType]
    const color = AGENT_COLORS[agentType] ?? MA
    const iterLabel = agentType === 'researcher' && iter > 1
      ? ` (gap-fill iter ${iter})`
      : iter > 1 ? ` (iter ${iter})` : ''
    console.log(`\n${B}${color}[CALLING AGENT: ${agentType}${iterLabel}]${R}`)
  }

  private handleSubagentToolCall(toolName: string, input: Msg, agentName: string): void {
    const color = AGENT_COLORS[agentName] ?? D
    if (toolName === 'WebSearch') {
      const query: string = input.query ?? JSON.stringify(input).slice(0, 100)
      console.log(`  ${color}[${agentName}:WebSearch  ▶]${R} ${D}${query}${R}`)
    } else if (toolName === 'WebFetch') {
      const url: string = input.url ?? input.prompt ?? JSON.stringify(input).slice(0, 100)
      console.log(`  ${color}[${agentName}:WebFetch   ▶]${R} ${D}${url.slice(0, 120)}${R}`)
    } else if (toolName.startsWith('mcp__rag__')) {
      const shortName = toolName.replace('mcp__rag__', '')
      console.log(`  ${color}[${agentName}:RAG:${shortName.padEnd(6)} ▶]${R} ${D}${JSON.stringify(input).slice(0, 120)}${R}`)
    } else {
      console.log(`  ${color}[${agentName}:${toolName.padEnd(12)} ▶]${R} ${D}${JSON.stringify(input).slice(0, 100)}${R}`)
    }
  }

  // ── Tool progress ────────────────────────────────────────────────────────

  private handleToolProgress(msg: Msg): void {
    const toolName: string = msg.tool_name ?? ''
    const inputStr = msg.tool_input ? JSON.stringify(msg.tool_input).slice(0, 120) : ''

    if (toolName.startsWith('mcp__rag__')) {
      const shortName = toolName.replace('mcp__rag__', '')
      console.log(`  ${GR}[RAG:${shortName.padEnd(6)} ▶]${R} ${D}${inputStr}${R}`)
    } else if (toolName === 'WebSearch') {
      const query: string = msg.tool_input?.query ?? inputStr
      console.log(`  ${YE}[tool:WebSearch  ▶]${R} ${D}${query}${R}`)
    } else if (toolName === 'WebFetch') {
      const url: string = msg.tool_input?.url ?? msg.tool_input?.prompt ?? inputStr
      console.log(`  ${YE}[tool:WebFetch   ▶]${R} ${D}${url.slice(0, 120)}${R}`)
    } else if (toolName && toolName !== 'Agent' && toolName !== 'Task') {
      console.log(`  ${D}[tool:${toolName.padEnd(12)} ▶]${R} ${D}${inputStr}${R}`)
    }
  }

  // ── Tool results ─────────────────────────────────────────────────────────

  private handleToolResult(msg: Msg): void {
    const toolName: string = msg.tool_name ?? ''
    const resultText = extractText(msg.content ?? [])

    if (toolName.startsWith('mcp__rag__')) {
      if (resultText) renderRagResult(toolName, resultText)
    } else if (toolName === 'WebSearch') {
      const urlCount = (resultText.match(/https?:\/\//g) ?? []).length
      console.log(`  ${YE}[tool:WebSearch  ◀]${R} ${D}${urlCount} URL(s) returned${R}`)
    } else if (toolName === 'WebFetch') {
      const status = resultText.length > 0 ? `${resultText.length} chars fetched` : 'empty response'
      console.log(`  ${YE}[tool:WebFetch   ◀]${R} ${D}${status}${R}`)
    }
  }

  // ── Final result ─────────────────────────────────────────────────────────

  private handleResult(msg: Msg): void {
    if (msg.subtype === 'success') {
      this.handleSuccess(msg)
    } else {
      const errors: string[] = msg.errors ?? []
      console.log(`\n${B}${RE}[ERROR: ${msg.subtype}]${R} ${errors.join(', ')}`)
    }
  }

  private handleSuccess(msg: Msg): void {
    const resultText: string = (msg.result as string) ?? ''
    const turns: number = msg.num_turns ?? 0
    const cost: number = msg.total_cost_usd ?? 0
    const jsonIdx = resultText.lastIndexOf('```json')
    const displayText = jsonIdx > 0 ? resultText.slice(0, jsonIdx).trim() : resultText
    const totalIters = Math.max(...Object.values(this.agentIterations), 0)
    const iterLabel = totalIters > 1 ? `${totalIters} research iterations | ` : ''

    console.log(`\n${B}${GR}${'═'.repeat(52)}${R}`)
    console.log(`${B}  FINAL ANSWER${R}  ${D}(${turns} turns | ${iterLabel}$${cost.toFixed(4)} USD)${R}`)
    console.log(`${GR}${'═'.repeat(52)}${R}\n`)
    console.log(displayText)
    console.log()
  }

  // ── Rate limit ───────────────────────────────────────────────────────────

  private handleRateLimit(msg: Msg): void {
    const info = msg.rate_limit_info ?? {}
    if (info.status === 'rejected') {
      console.log(`\n${RE}[RATE LIMITED]${R} Resets at: ${info.resets_at ?? 'unknown'}`)
    } else if (info.status === 'allowed_warning') {
      console.log(`${YE}[rate limit warning]${R}`)
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

const renderer = new Renderer()
export const renderMessage = (msg: Msg) => renderer.render(msg)
