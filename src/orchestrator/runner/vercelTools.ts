import { tool } from 'ai'
import { z } from 'zod'
import { AGENT_COLORS, D, R } from '../../libs/ansi.js'
import type { AgentName, ResearchBudget, ResearchRuntime } from '../types.js'

export function buildResearcherTools(color: string, budget?: ResearchBudget) {
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

export function buildSynthesizerTools(agent: AgentName, color: string, runtime: ResearchRuntime) {
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
