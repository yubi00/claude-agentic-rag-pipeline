import { tool } from 'ai'
import { z } from 'zod'
import { AGENT_COLORS, D, R } from '../../libs/ansi.js'
import type { AgentName, ResearchBudget, ResearchRuntime } from '../types.js'
import type { IRagStore } from '../../rag/interface.js'

export interface ResearcherToolContext {
    tools: ReturnType<typeof buildResearcherToolset>
    failedUrls: Set<string>
    isBudgetExhausted: () => boolean
}

export function buildResearcherTools(color: string, budget?: ResearchBudget, ragStore?: IRagStore): ResearcherToolContext {
    const failedUrls = new Set<string>()
    const usage = { searches: 0, fetches: 0 }
    const maxSearches = budget?.maxSearchesTotal ?? Infinity
    const maxFetches = budget?.maxFetchesTotal ?? Infinity
    return {
        tools: buildResearcherToolset(color, budget, failedUrls, usage, ragStore),
        failedUrls,
        isBudgetExhausted: () => usage.searches >= maxSearches && usage.fetches >= maxFetches,
    }
}

function buildResearcherToolset(
    color: string,
    budget: ResearchBudget | undefined,
    failedUrls: Set<string>,
    usage: { searches: number; fetches: number },
    ragStore?: IRagStore
) {
    const maxSearches = budget?.maxSearchesTotal ?? Infinity
    const maxFetches = budget?.maxFetchesTotal ?? Infinity

    return {
        WebSearch: tool<{ query: string }, string>({
            description: 'Search the web for information relevant to the research task.',
            inputSchema: z.object({ query: z.string().describe('The search query') }),
            execute: async ({ query }) => {
                if (usage.searches >= maxSearches) return 'Search budget exhausted.'
                usage.searches++

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
                if (usage.fetches >= maxFetches) return 'Fetch budget exhausted.'
                usage.fetches++

                console.log(`  ${color}[researcher:WebFetch   ▶]${R} ${D}${url.slice(0, 160)}${R}`)
                console.log(`  ${D}[researcher] fetching via Jina Reader...${R}`)

                try {
                    const res = await fetch(`https://r.jina.ai/${url}`, {
                        headers: {
                            'Accept': 'text/plain',
                            'X-Timeout': '15',
                        },
                        signal: AbortSignal.timeout(20_000),
                    })
                    const text = (await res.text()).slice(0, 12_000)

                    console.log(`  ${color}[researcher:WebFetch   ◀]${R} ${D}${text.length} chars fetched${R}`)
                    console.log(`  ${D}[researcher] analysing results...${R}`)

                    if (text.length < 100) {
                        failedUrls.add(url)
                        return 'Page returned no readable content.'
                    }

                    if (ragStore) {
                        const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? url
                        await ragStore.addDocument({ url, title, content: text })
                        console.log(`  ${D}[researcher:WebFetch] indexed: ${title.slice(0, 80)}${R}`)
                    }

                    return `Fetched and indexed: ${url}`
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    console.log(`  ${color}[researcher:WebFetch   ◀]${R} ${D}failed: ${msg}${R}`)
                    failedUrls.add(url)
                    return `Failed to fetch ${url}: ${msg}`
                }
            },
        }),
    }
}

export function buildSynthesizerTools(agent: AgentName, color: string, runtime: ResearchRuntime) {
    // Mutex to serialise parallel search_documents calls — Gemini fires them concurrently
    // but sequential execution is required for the ReAct observe-then-decide loop.
    let searchQueue = Promise.resolve()

    return {
        search_documents: tool<{ query: string; max_results?: number }, object>({
            description: 'Search the indexed knowledge base for relevant documents.',
            inputSchema: z.object({
                query: z.string().describe('The search query'),
                max_results: z.number().optional().describe('Maximum number of results (default 5)'),
            }),
            execute: ({ query, max_results = 5 }) => {
                const result = searchQueue.then(async () => {
                    console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ▶]${R} ${D}${query.slice(0, 140)}${R}`)
                    const res = await runtime.ragStore.searchDocuments(query, max_results)
                    console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ◀]${R} ${D}${res.resultCount} result(s)${R}`)
                    return res
                })
                searchQueue = result.then(() => { }, () => { })
                return result
            },
        }),
    }
}

