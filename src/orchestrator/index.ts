/**
 * Orchestrator — runs a research session with code-enforced sequencing.
 *
 * Flow per iteration:
 *   1. researcher  -> gather live web evidence
 *   2. indexer     -> add researcher output into the RAG store
 *   3. synthesizer -> answer using ONLY indexed knowledge
 *   4. parse confidence
 *   5. if confidence is not high, run another targeted researcher round
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { researcherDef } from '../agents/researcher.js'
import { indexerDef } from '../agents/indexer.js'
import { synthesizerDef } from '../agents/synthesizer.js'
import { makeToolLimiterHooks } from './limiter.js'
import { DISALLOWED_TOOLS } from './toolConfig.js'
import { logger } from '../libs/logger.js'
import { AGENT_COLORS, B, D, GR, R, RE, YE } from '../libs/ansi.js'
import { AGENT_FORMATTERS } from '../libs/agentFormatters.js'
import { extractText, parseConfidenceBlock, type ConfidenceBlock } from '../utils/index.js'
import { ragServer, ragStore } from '../rag/index.js'

type AgentName = 'researcher' | 'indexer' | 'synthesizer'

type Msg = any

interface AgentRunResult {
    text: string
    turns: number
    costUsd: number
    durationMs: number
}

interface SessionTotals {
    turns: number
    costUsd: number
}

interface DedupedResearchResult {
    text: string
    removedCount: number
}

interface ResearchBudget {
    maxFetchesTotal: number
    maxSearchesTotal: number
}

export interface ResearchSessionOptions {
    deepResearch?: boolean
}

const MAX_ITERATIONS = Number(process.env.MAX_RESEARCH_ITERATIONS ?? 3)
const CLEAR_RAG_ON_START = process.env.CLEAR_RAG_ON_START !== 'false'
const DEFAULT_MODEL = process.env.AGENT_MODEL ?? 'claude-haiku-4-5-20251001'
const INITIAL_FETCH_BUDGET = Number(process.env.INITIAL_WEB_FETCHES ?? 5)
const GAP_FETCH_BUDGET = Number(process.env.GAP_WEB_FETCHES ?? 3)
const INITIAL_SEARCH_BUDGET = Number(process.env.INITIAL_WEB_SEARCHES ?? 5)
const GAP_SEARCH_BUDGET = Number(process.env.GAP_WEB_SEARCHES ?? 3)
const DEFAULT_DEEP_RESEARCH = process.env.DEEP_RESEARCH === 'true'

const AGENT_MODELS: Record<AgentName, string> = {
    researcher: process.env.RESEARCHER_MODEL ?? DEFAULT_MODEL,
    indexer: process.env.INDEXER_MODEL ?? DEFAULT_MODEL,
    synthesizer: process.env.SYNTHESIZER_MODEL ?? DEFAULT_MODEL,
}

const AGENT_TOOLSETS: Record<AgentName, string[]> = {
    researcher: ['WebSearch', 'WebFetch'],
    indexer: ['mcp__rag__index_document', 'mcp__rag__list_indexed'],
    synthesizer: ['mcp__rag__search_documents'],
}

export async function runResearchSession(question: string, options: ResearchSessionOptions = {}): Promise<void> {
    const deepResearch = options.deepResearch ?? DEFAULT_DEEP_RESEARCH

    logger.info({ event: 'session.start', question, deepResearch })

    if (CLEAR_RAG_ON_START) {
        await ragStore.clearDocuments()
        logger.info({ event: 'session.rag_cleared' })
    }

    const startedAt = Date.now()
    const totals: SessionTotals = { turns: 0, costUsd: 0 }
    const previouslyCovered = new Set<string>()

    let finalAnswer = ''
    let finalConfidence: ConfidenceBlock | null = null
    let completedIterations = 0

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
        completedIterations = iteration

        const researchBudget = getResearchBudget(iteration)
        const researcherTask = buildResearchTask(question, iteration, finalConfidence, [...previouslyCovered], researchBudget)
        const researcher = await runAgent('researcher', researcherTask, researchBudget)
        totals.turns += researcher.turns
        totals.costUsd += researcher.costUsd

        const dedupedResearch = dedupeResearchOutput(researcher.text, previouslyCovered)
        extractSourceUrls(dedupedResearch.text).forEach(url => previouslyCovered.add(normalizeUrl(url)))
        if (dedupedResearch.removedCount > 0) {
            console.log(`  ${D}[researcher:dedupe] removed ${dedupedResearch.removedCount} previously covered source(s)${R}`)
        }

        const sourceCount = extractSourceUrls(dedupedResearch.text).length
        if (sourceCount === 0) {
            const previousMissingTopics: string[] = finalConfidence ? finalConfidence.missingTopics : []
            finalConfidence = {
                confidence: 'low',
                missingTopics: previousMissingTopics,
                coverageNotes: 'Researcher returned no new indexable SOURCE blocks for this iteration.',
            }

            const stopping = iteration >= MAX_ITERATIONS
            console.log(`  ${YE}[orchestrator:skip]${R} ${D}no new source blocks to index; retrying without synthesizer${R}`)
            logConfidenceDecision(iteration, finalConfidence, stopping)

            if (stopping) break
            continue
        }

        const indexer = await runAgent('indexer', dedupedResearch.text)
        totals.turns += indexer.turns
        totals.costUsd += indexer.costUsd

        const synthesizerPrompt = buildSynthesizerPrompt(question, iteration, finalConfidence)
        const synthesizer = await runAgent('synthesizer', synthesizerPrompt)
        totals.turns += synthesizer.turns
        totals.costUsd += synthesizer.costUsd

        finalAnswer = stripConfidenceBlock(synthesizer.text)
        finalConfidence =
            parseConfidenceBlock(synthesizer.text) ?? {
                confidence: 'low',
                missingTopics: [],
                coverageNotes: 'Synthesizer response did not include a confidence block.',
            }

        const stopping = shouldStop(iteration, finalConfidence, deepResearch)
        logConfidenceDecision(iteration, finalConfidence, stopping)

        if (stopping) break
    }

    renderFinalAnswer(finalAnswer, finalConfidence, totals, completedIterations)

    logger.info({
        event: 'session.end',
        turns: totals.turns,
        costUsd: totals.costUsd,
        iterations: completedIterations,
        durationMs: Date.now() - startedAt,
    })
}

async function runAgent(agent: AgentName, prompt: string, researchBudget?: ResearchBudget): Promise<AgentRunResult> {
    const color = AGENT_COLORS[agent]
    console.log(`\n${B}${color}[CALLING AGENT: ${agent}]${R}`)

    const stream = query({
        prompt,
        options: {
            model: AGENT_MODELS[agent],
            systemPrompt: getAgentPrompt(agent),
            tools: AGENT_TOOLSETS[agent],
            allowedTools: AGENT_TOOLSETS[agent],
            disallowedTools: DISALLOWED_TOOLS,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            persistSession: false,
            maxTurns: agent === 'synthesizer' ? 16 : 12,
            hooks: agent === 'researcher'
                ? makeToolLimiterHooks({
                    maxWebFetches: researchBudget?.maxFetchesTotal,
                    maxWebSearches: researchBudget?.maxSearchesTotal,
                })
                : undefined,
            mcpServers: agent === 'researcher' ? undefined : { rag: ragServer },
        },
    })

    const startedAt = Date.now()
    let finalText = ''
    let turns = 0
    let costUsd = 0

    for await (const msg of stream) {
        renderAgentMessage(agent, msg)

        if (msg?.type === 'result' && msg.subtype === 'success') {
            finalText = String(msg.result ?? '')
            turns = Number(msg.num_turns ?? 0)
            costUsd = Number(msg.total_cost_usd ?? 0)
        }
    }

    return {
        text: finalText,
        turns,
        costUsd,
        durationMs: Date.now() - startedAt,
    }
}

function renderAgentMessage(agent: AgentName, msg: Msg): void {
    if (msg?.type === 'system') {
        if (msg.subtype === 'task_started') {
            const desc = msg.description ?? msg.task_description ?? `Run ${agent}`
            console.log(`\n${B}${AGENT_COLORS[agent]}[AGENT STARTED]${R} ${desc}`)
        }

        if (msg.subtype === 'task_progress') {
            const usage = msg.usage ?? msg.cumulative_usage ?? {}
            const tools = usage.tool_uses ?? usage.toolUses ?? '?'
            const tokens = usage.total_tokens ?? usage.totalTokens ?? '?'
            const ms = usage.duration_ms ?? usage.durationMs ?? 0
            console.log(`  ${D}[progress] ${tools} tool calls | ${tokens} tokens | ${(ms / 1000).toFixed(1)}s${R}`)
            if (msg.summary) console.log(`  ${D}[summary] ${msg.summary}${R}`)
        }

        return
    }

    if (msg?.type === 'assistant') {
        const blocks = msg.message?.content ?? []
        for (const block of blocks) {
            if (block.type === 'thinking') {
                const preview = String(block.thinking ?? '').replace(/\n/g, ' ').slice(0, 140)
                if (preview) console.log(`  ${D}[${agent}:thinking] ${preview}…${R}`)
            }

            if (block.type === 'text') {
                const text = String(block.text ?? '')
                if (text.trim()) AGENT_FORMATTERS[agent]?.(text)
            }

            if (block.type === 'tool_use') {
                logToolCall(agent, String(block.name ?? ''), block.input ?? {})
            }
        }
        return
    }

    if (msg?.type === 'tool_progress') {
        const toolName = String(msg.tool_name ?? '')
        const input = msg.tool_input ?? {}
        logToolCall(agent, toolName, input)
        return
    }

    if (msg?.type === 'tool_result') {
        const toolName = String(msg.tool_name ?? '')
        const status = msg.status ?? msg.tool_status ?? ''
        const resultText = extractText(msg.content ?? [])

        if (status && !['ok', 'success', 'succeeded'].includes(String(status))) {
            const err = String(msg.error ?? msg.error_message ?? resultText).slice(0, 200)
            console.log(`  ${RE}[${agent}:${toolName} FAILED]${R} ${D}${err}${R}`)
            return
        }

        if (toolName === 'WebSearch') {
            const urlCount = (resultText.match(/https?:\/\//g) ?? []).length
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebSearch  ◀]${R} ${D}${urlCount} URL(s) returned${R}`)
            return
        }

        if (toolName === 'WebFetch') {
            const fetched = resultText.length > 0 ? `${resultText.length} chars fetched` : 'empty response'
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebFetch   ◀]${R} ${D}${fetched}${R}`)
            return
        }

        if (toolName.startsWith('mcp__rag__')) {
            const shortName = toolName.replace('mcp__rag__', '')
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:${shortName.padEnd(16)} ◀]${R} ${D}${summarizeToolResult(resultText)}${R}`)
        }
        return
    }

    if (msg?.type === 'result' && msg.subtype !== 'success') {
        const errors = (msg.errors ?? []).join(', ')
        console.log(`  ${RE}[${agent}:ERROR]${R} ${errors}`)
    }
}

function logToolCall(agent: AgentName, toolName: string, input: Msg): void {
    if (!toolName) return

    if (toolName === 'WebSearch') {
        console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebSearch  ▶]${R} ${D}${String(input.query ?? '').slice(0, 140)}${R}`)
        return
    }

    if (toolName === 'WebFetch') {
        const url = String(input.url ?? input.prompt ?? '').slice(0, 160)
        console.log(`  ${AGENT_COLORS[agent]}[${agent}:WebFetch   ▶]${R} ${D}${url}${R}`)
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
        const parsed = JSON.parse(resultText)
        if ('resultCount' in parsed) return `${parsed.resultCount ?? 0} result(s)`
        if ('totalDocuments' in parsed) return `${parsed.totalDocuments ?? 0} document(s) in knowledge base`
        if ('title' in parsed) return `indexed \"${parsed.title ?? ''}\"`
        return JSON.stringify(parsed).slice(0, 120)
    } catch {
        return resultText.replace(/\s+/g, ' ').slice(0, 120)
    }
}

function getAgentPrompt(agent: AgentName): string {
    if (agent === 'researcher') return researcherDef.prompt
    if (agent === 'indexer') return indexerDef.prompt
    return synthesizerDef.prompt
}

function buildResearchTask(
    question: string,
    iteration: number,
    previousConfidence: ConfidenceBlock | null,
    previouslyCovered: string[],
    budget: ResearchBudget
): string {
    if (iteration === 1 || !previousConfidence || previousConfidence.missingTopics.length === 0) {
        const queries = buildInitialQueries(question)
        return JSON.stringify(
            {
                queries,
                context: `initial research for: ${question}`,
                isGapFilling: false,
                previouslyCovered,
                maxFetchesTotal: budget.maxFetchesTotal,
            },
            null,
            2
        )
    }

    const queries = buildGapQueries(question, previousConfidence)
    return JSON.stringify(
        {
            queries,
            context: `gap filling for: ${question}`,
            isGapFilling: true,
            previouslyCovered,
            maxFetchesTotal: budget.maxFetchesTotal,
        },
        null,
        2
    )
}

function getResearchBudget(iteration: number): ResearchBudget {
    if (iteration <= 1) {
        return {
            maxFetchesTotal: INITIAL_FETCH_BUDGET,
            maxSearchesTotal: INITIAL_SEARCH_BUDGET,
        }
    }

    return {
        maxFetchesTotal: GAP_FETCH_BUDGET,
        maxSearchesTotal: GAP_SEARCH_BUDGET,
    }
}

function buildInitialQueries(question: string): string[] {
    const normalized = question.trim().replace(/[?.!]+$/, '')
    const queries = new Set<string>([normalized])

    if (/\b(today|latest|recent|current|this week|this weekend|tonight)\b/i.test(normalized)) {
        queries.add(`${normalized} official sources`)
    } else {
        queries.add(`${normalized} guide`)
    }

    return [...queries].slice(0, 2)
}

function buildGapQueries(question: string, confidence: ConfidenceBlock): string[] {
    const subjectHint = extractSubjectHint(question)
    const queries = new Set<string>()

    for (const topic of confidence.missingTopics.slice(0, 3)) {
        const normalizedTopic = topic.trim()
        if (!normalizedTopic) continue

        queries.add(`${normalizedTopic} ${subjectHint}`.trim())

        if (/opening hours|hours|times/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} official opening hours`)
        } else if (/price|pricing|admission|ticket|fee|cost/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} official ticket prices`)
        } else if (/history|historical|colonial|landmark/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} historical landmarks guide`)
        } else if (/museum|gallery|art/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} art galleries museums`)
        }
    }

    if (queries.size === 0) {
        queries.add(`${question.trim().replace(/[?.!]+$/, '')} official sources`)
    }

    return [...queries].slice(0, 3)
}

function extractSubjectHint(question: string): string {
    return question
        .replace(/^can you tell me|^what are|^what is|^find|^show me/gi, '')
        .replace(/\b(top|best|five|places|visit|events|happening|this weekend|today|latest|current)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim() || question.trim()
}

function buildSynthesizerPrompt(
    question: string,
    iteration: number,
    previousConfidence: ConfidenceBlock | null
): string {
    if (iteration === 1 || !previousConfidence || previousConfidence.missingTopics.length === 0) {
        return question
    }

    return `KNOWN GAPS: ${previousConfidence.missingTopics.join(', ')}\n\nQuestion: ${question}`
}

function extractSourceUrls(text: string): string[] {
    return [...text.matchAll(/^SOURCE:\s*(.+)$/gm)].map(match => match[1].trim())
}

function dedupeResearchOutput(text: string, previouslyCovered: Set<string>): DedupedResearchResult {
    const blocks = text.match(/---\nSOURCE:[\s\S]*?(?=\n---\nSOURCE:|\nRESEARCH SUMMARY:|$)/g) ?? []
    if (blocks.length === 0) return { text, removedCount: 0 }

    const keptBlocks: string[] = []
    let removedCount = 0

    for (const block of blocks) {
        const urlMatch = block.match(/^SOURCE:\s*(.+)$/m)
        const normalizedUrl = normalizeUrl(urlMatch?.[1] ?? '')
        if (!normalizedUrl || previouslyCovered.has(normalizedUrl)) {
            removedCount++
            continue
        }
        keptBlocks.push(block.trim())
    }

    const summaryMatch = text.match(/RESEARCH SUMMARY:[\s\S]*$/)
    const summary = summaryMatch ? `\n\n${summaryMatch[0].trim()}` : ''

    if (keptBlocks.length === 0) {
        return {
            text: 'RESEARCH SUMMARY: No new unique sources were fetched after deduplication.',
            removedCount,
        }
    }

    return {
        text: `${keptBlocks.join('\n\n')}${summary}`,
        removedCount,
    }
}

function normalizeUrl(url: string): string {
    const trimmed = url.trim()
    if (!trimmed) return ''

    try {
        const parsed = new URL(trimmed)
        parsed.hash = ''
        const path = parsed.pathname.replace(/\/$/, '') || '/'
        return `${parsed.origin}${path}${parsed.search}`
    } catch {
        return trimmed.replace(/\/$/, '')
    }
}

function stripConfidenceBlock(text: string): string {
    const jsonIdx = text.lastIndexOf('```json')
    return jsonIdx > 0 ? text.slice(0, jsonIdx).trim() : text.trim()
}

function shouldStop(iteration: number, confidence: ConfidenceBlock, deepResearch: boolean): boolean {
    if (iteration >= MAX_ITERATIONS) return true

    if (deepResearch) {
        return confidence.confidence === 'high'
    }

    return confidence.confidence !== 'low'
}

function logConfidenceDecision(iteration: number, confidence: ConfidenceBlock, stopping: boolean): void {
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

function renderFinalAnswer(
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
