/**
 * Orchestrator presenter.
 *
 * This is the single runtime path for rendering agent progress, tool activity,
 * confidence decisions, and final answers to the terminal.
 */

import { AGENT_FORMATTERS } from '../libs/agentFormatters.js'
import { AGENT_COLORS, B, D, GR, R, RE, YE } from '../libs/ansi.js'
import { extractText, type ConfidenceBlock } from '../utils/index.js'
import { MAX_ITERATIONS } from './config.js'
import type {
    AgentName,
    JsonRecord,
    SdkAssistantBlock,
    SdkStreamMessage,
    SdkToolResultContentBlock,
    SessionTotals,
} from './types.js'

export function renderAgentStart(agent: AgentName): void {
    const color = AGENT_COLORS[agent]
    console.log(`\n${B}${color}[CALLING AGENT: ${agent}]${R}`)
}

export function renderAgentMessage(agent: AgentName, msg: SdkStreamMessage): void {
    if (msg.type === 'system') {
        if (msg.subtype === 'task_started') {
            const desc = String(msg.description ?? msg.task_description ?? `Run ${agent}`)
            console.log(`\n${B}${AGENT_COLORS[agent]}[AGENT STARTED]${R} ${desc}`)
        }

        if (msg.subtype === 'task_progress') {
            const usage = msg.usage ?? msg.cumulative_usage ?? {}
            const tools = String(usage.tool_uses ?? usage.toolUses ?? '?')
            const tokens = String(usage.total_tokens ?? usage.totalTokens ?? '?')
            const ms = Number(usage.duration_ms ?? usage.durationMs ?? 0)
            console.log(`  ${D}[progress] ${tools} tool calls | ${tokens} tokens | ${(ms / 1000).toFixed(1)}s${R}`)
            if (msg.summary) console.log(`  ${D}[summary] ${String(msg.summary)}${R}`)
        }

        return
    }

    if (msg.type === 'assistant') {
        const blocks = msg.message?.content ?? []

        for (const block of blocks) {
            renderAssistantBlock(agent, block)
        }
        return
    }

    if (msg.type === 'tool_progress') {
        const toolName = String(msg.tool_name ?? '')
        logToolCall(agent, toolName, msg.tool_input ?? {})
        return
    }

    if (msg.type === 'tool_result') {
        const toolName = String(msg.tool_name ?? '')
        const status = String(msg.status ?? msg.tool_status ?? '')
        const content = msg.content ?? []
        const resultText = extractText(content as SdkToolResultContentBlock[])

        if (status && !['ok', 'success', 'succeeded'].includes(status)) {
            const err = String(msg.error ?? msg.error_message ?? resultText).slice(0, 200)
            console.log(`  ${RE}[${agent}:${toolName} FAILED]${R} ${D}${err}${R}`)
            return
        }

        if (toolName === 'WebSearch') {
            const urlCount = (resultText.match(/https?:\/\//g) ?? []).length
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebSearch  ◀]${R} ${D}${urlCount} URL(s) returned${R}`)
            console.log(`  ${D}[${agent}] analysing results...${R}`)
            return
        }

        if (toolName === 'WebFetch') {
            const fetched = resultText.length > 0 ? `${resultText.length} chars fetched` : 'empty response'
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebFetch   ◀]${R} ${D}${fetched}${R}`)
            console.log(`  ${D}[${agent}] analysing results...${R}`)
            return
        }

        if (toolName.startsWith('mcp__rag__')) {
            const shortName = toolName.replace('mcp__rag__', '')
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:${shortName.padEnd(16)} ◀]${R} ${D}${summarizeToolResult(resultText)}${R}`)
        }
        return
    }

    if (msg.type === 'result' && msg.subtype !== 'success') {
        const errors = msg.errors?.join(', ') ?? ''
        console.log(`  ${RE}[${agent}:ERROR]${R} ${errors}`)
    }
}

export function logConfidenceDecision(iteration: number, confidence: ConfidenceBlock, stopping: boolean): void {
    const color =
        confidence.confidence === 'high'
            ? GR
            : confidence.confidence === 'medium'
                ? YE
                : RE

    console.log(`\n${B}${color}[ORCHESTRATOR:decision] iter=${iteration} confidence=${confidence.confidence.toUpperCase()}${R}`)
    if (stopping && confidence.confidence !== 'high' && iteration >= MAX_ITERATIONS) {
        console.log(`  ${D}→ stopping: max iterations reached${R}`)
    } else if (confidence.confidence === 'low' && confidence.missingTopics.length > 0) {
        console.log(`  ${D}→ will gap-fill: ${confidence.missingTopics.join(', ')}${R}`)
    } else if (confidence.confidence === 'low') {
        console.log(`  ${D}→ will broaden search for another pass${R}`)
    } else {
        console.log(`  ${D}→ stopping${R}`)
    }
}

export function renderFinalAnswer(
    answer: string,
    confidence: ConfidenceBlock | null,
    totals: SessionTotals,
    iterations: number
): void {
    console.log(`\n${B}${GR}${'═'.repeat(52)}${R}`)
    console.log(`${B}  FINAL ANSWER${R}  ${D}(${totals.turns} turns | ${iterations} iteration(s) | $${totals.costUsd.toFixed(4)} USD)${R}`)
    console.log(`${GR}${'═'.repeat(52)}${R}\n`)
    console.log(answer)

    if (confidence && confidence.confidence !== 'high' && confidence.coverageNotes) {
        console.log(`\n> Coverage note: ${confidence.coverageNotes}`)
    }

    console.log()
}

function renderAssistantBlock(agent: AgentName, block: SdkAssistantBlock): void {
    if (block.type === 'thinking') {
        const preview = String(block.thinking ?? '').replace(/\n/g, ' ').slice(0, 140)
        if (preview) console.log(`  ${D}[${agent}:thinking] ${preview}…${R}`)
        return
    }

    if (block.type === 'text') {
        const text = String(block.text ?? '')
        if (text.trim()) AGENT_FORMATTERS[agent]?.(text)
        return
    }

    logToolCall(agent, String(block.name ?? ''), block.input ?? {})
}

function logToolCall(agent: AgentName, toolName: string, input: JsonRecord): void {
    if (!toolName) return

    if (toolName === 'WebSearch') {
        console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebSearch  ▶]${R} ${D}${String(input.query ?? '').slice(0, 140)}${R}`)
        return
    }

    if (toolName === 'WebFetch') {
        const url = String(input.url ?? input.prompt ?? '').slice(0, 160)
        console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebFetch   ▶]${R} ${D}${url}${R}`)
        console.log(`  ${D}[${agent}] fetching page, this may take a moment...${R}`)
        return
    }

    if (toolName.startsWith('mcp__rag__')) {
        const shortName = toolName.replace('mcp__rag__', '')
        console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:${shortName.padEnd(16)} ▶]${R} ${D}${JSON.stringify(input).slice(0, 140)}${R}`)
    }
}

function summarizeToolResult(resultText: string): string {
    if (!resultText.trim()) return 'empty response'

    try {
        const parsed = JSON.parse(resultText) as Record<string, unknown>
        if ('resultCount' in parsed) return `${parsed.resultCount ?? 0} result(s)`
        if ('totalDocuments' in parsed) return `${parsed.totalDocuments ?? 0} document(s) in knowledge base`
        if ('title' in parsed) return `indexed \"${parsed.title ?? ''}\"`
        return JSON.stringify(parsed).slice(0, 120)
    } catch {
        return resultText.replace(/\s+/g, ' ').slice(0, 120)
    }
}
