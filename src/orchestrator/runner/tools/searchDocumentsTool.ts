import { tool } from 'ai'
import { z } from 'zod'
import { AGENT_COLORS, D, R } from '../../../libs/ansi.js'
import type { AgentName, ResearchRuntime } from '../../types.js'

export function createSearchDocumentsTool(agent: AgentName, runtime: ResearchRuntime) {
    // Mutex to serialise parallel search_documents calls — Gemini fires them concurrently
    // but sequential execution is required for the ReAct observe-then-decide loop.
    let searchQueue = Promise.resolve()

    return tool<{ query: string; max_results?: number }, object>({
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
    })
}
