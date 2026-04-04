import { ToolLoopAgent, tool, stepCountIs } from 'ai'
import { google } from '@ai-sdk/google'
import { z } from 'zod'
import { AGENT_COLORS, B, D, R, RE } from '../../libs/ansi.js'
import { getAgentPrompt } from '../config.js'
import { renderAgentStart } from '../presenter.js'
import { logger } from '../../libs/logger.js'
import type { AgentName, AgentRunResult, ResearchBudget, ResearchRuntime } from '../types.js'
import type { IAgentRunner } from './interface.js'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'

// Gemini Flash 2.0 pricing (per 1M tokens)
const INPUT_COST_PER_M = 0.10
const OUTPUT_COST_PER_M = 0.40

export class VercelAgentRunner implements IAgentRunner {
    async run(
        agent: AgentName,
        prompt: string,
        runtime: ResearchRuntime,
        budget?: ResearchBudget
    ): Promise<AgentRunResult> {
        renderAgentStart(agent)

        const color = AGENT_COLORS[agent] ?? ''
        const startedAt = Date.now()
        const maxSteps = agent === 'synthesizer' ? 16 : 12

        const agentInstance = new ToolLoopAgent({
            model: google(GEMINI_MODEL),
            instructions: getAgentPrompt(agent),
            tools: buildTools(agent, runtime, budget, color),
            stopWhen: stepCountIs(maxSteps),
            onStepFinish: (step) => {
                const tools = step.toolCalls.map(tc => tc.toolName).join(', ')
                if (tools) console.log(`  ${D}[${agent}:step ${step.stepNumber + 1}] tools: ${tools}${R}`)
            },
        })

        let result: Awaited<ReturnType<typeof agentInstance.generate>>
        try {
            result = await agentInstance.generate({ prompt })
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(`\n  ${RE}[${agent}:ERROR]${R} ${msg}`)
            logger.error({ event: 'agent.error', agent, model: GEMINI_MODEL, err: msg })
            throw err
        }

        const { inputTokens = 0, outputTokens = 0 } = result.totalUsage
        const costUsd = (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M

        console.log(`  ${D}[${agent}] ${B}done${R} ${D}${result.steps.length} step(s) | ${inputTokens + outputTokens} tokens${R}`)

        return {
            text: result.text,
            turns: result.steps.length,
            costUsd,
            durationMs: Date.now() - startedAt,
        }
    }
}

function buildTools(agent: AgentName, runtime: ResearchRuntime, budget: ResearchBudget | undefined, color: string) {
    if (agent === 'researcher') return buildResearcherTools(color, budget)
    return buildSynthesizerTools(agent, color, runtime)
}

function buildResearcherTools(color: string, budget?: ResearchBudget) {
    let searchesUsed = 0
    let fetchesUsed = 0
    const maxSearches = budget?.maxSearchesTotal ?? Infinity
    const maxFetches = budget?.maxFetchesTotal ?? Infinity

    return {
        WebSearch: tool<{ query: string }, string>({
            description: 'Search the web for information relevant to the research task.',
            inputSchema: z.object({ query: z.string().describe('The search query') }),
            execute: async ({ query }) => {
                if (searchesUsed >= maxSearches) return 'Search budget exhausted.'
                searchesUsed++

                console.log(`  ${color}[researcher:WebSearch  ▶]${R} ${D}${query.slice(0, 140)}${R}`)

                const apiKey = process.env.TAVILY_API_KEY
                if (!apiKey) throw new Error('TAVILY_API_KEY is not set')

                const res = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
                })
                const data = await res.json() as { results: Array<{ url: string; title: string; content: string }> }
                const results = data.results ?? []

                console.log(`  ${color}[researcher:WebSearch  ◀]${R} ${D}${results.length} URL(s) returned${R}`)
                console.log(`  ${D}[researcher] analysing results...${R}`)

                return results.map(r => `URL: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.content}`).join('\n\n')
            },
        }),

        WebFetch: tool<{ url: string }, string>({
            description: 'Fetch the full text content of a web page.',
            inputSchema: z.object({ url: z.string().describe('The URL to fetch') }),
            execute: async ({ url }) => {
                if (fetchesUsed >= maxFetches) return 'Fetch budget exhausted.'
                fetchesUsed++

                console.log(`  ${color}[researcher:WebFetch   ▶]${R} ${D}${url.slice(0, 160)}${R}`)
                console.log(`  ${D}[researcher] fetching page, this may take a moment...${R}`)

                try {
                    const res = await fetch(url, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' },
                        signal: AbortSignal.timeout(15_000),
                    })
                    const html = await res.text()
                    const text = extractText(html).slice(0, 12_000)

                    console.log(`  ${color}[researcher:WebFetch   ◀]${R} ${D}${text.length} chars fetched${R}`)
                    console.log(`  ${D}[researcher] analysing results...${R}`)

                    return text || 'Page returned no readable content.'
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    console.log(`  ${color}[researcher:WebFetch   ◀]${R} ${D}failed: ${msg}${R}`)
                    return `Failed to fetch ${url}: ${msg}`
                }
            },
        }),
    }
}

function buildSynthesizerTools(agent: AgentName, color: string, runtime: ResearchRuntime) {
    return {
        search_documents: tool<{ query: string; max_results?: number }, object>({
            description: 'Search the indexed knowledge base for relevant documents.',
            inputSchema: z.object({
                query: z.string().describe('The search query'),
                max_results: z.number().optional().describe('Maximum number of results (default 5)'),
            }),
            execute: async ({ query, max_results = 5 }) => {
                console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ▶]${R} ${D}${query.slice(0, 140)}${R}`)
                const result = await runtime.ragStore.searchDocuments(query, max_results)
                console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ◀]${R} ${D}${result.resultCount} result(s)${R}`)
                return result
            },
        }),
    }
}

function extractText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
}
