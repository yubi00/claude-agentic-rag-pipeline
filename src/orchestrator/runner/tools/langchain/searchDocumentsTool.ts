import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { AGENT_COLORS, D, R } from '../../../../libs/ansi.js'
import type { AgentName, ResearchRuntime } from '../../../types.js'

export function createSearchDocumentsTool(agent: AgentName, runtime: ResearchRuntime) {
    // LangChain's ReAct loop is sequential by design (think → act → observe, one step at a time)
    // so no mutex is needed here unlike the Vercel runner where Gemini parallelises calls.
    return new DynamicStructuredTool({
        name: 'search_documents',
        description: 'Search the indexed knowledge base for relevant documents.',
        schema: z.object({
            query: z.string().describe('The search query'),
            max_results: z.number().optional().describe('Maximum number of results (default 5)'),
        }),
        func: async ({ query, max_results = 5 }) => {
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ▶]${R} ${D}${query.slice(0, 140)}${R}`)
            const res = await runtime.ragStore.searchDocuments(query, max_results)
            console.log(`  ${AGENT_COLORS[agent]}[${agent}:RAG:search_documents ◀]${R} ${D}${res.resultCount} result(s)${R}`)
            return JSON.stringify(res)
        },
    })
}
