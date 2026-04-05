import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { AGENT_COLORS, D, R } from '../../../../libs/ansi.js'
import type { AgentName, ResearchRuntime } from '../../../types.js'

export function createSearchDocumentsTool(agent: AgentName, runtime: ResearchRuntime) {
    // Strands TypeScript SDK executes tools sequentially by design —
    // no mutex needed (unlike the Vercel runner where Gemini fires parallel calls).
    return tool({
        name: 'search_documents',
        description: 'Search the indexed knowledge base for relevant documents.',
        inputSchema: z.object({
            query: z.string().describe('The search query'),
            max_results: z.number().optional().describe('Maximum number of results (default 5)'),
        }),
        callback: async ({ query, max_results = 5 }) => {
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ▶]${R} ${D}${query.slice(0, 140)}${R}`)
            const res = await runtime.ragStore.searchDocuments(query, max_results)
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ◀]${R} ${D}${res.resultCount} result(s)${R}`)
            return JSON.stringify(res)
        },
    })
}
