import { researcherDef } from '../agents/researcher.js'
import { indexerDef } from '../agents/indexer.js'
import { synthesizerDef } from '../agents/synthesizer.js'
import type { AgentName } from './types.js'

export const MAX_ITERATIONS = Number(process.env.MAX_RESEARCH_ITERATIONS ?? 3)
export const CLEAR_RAG_ON_START = process.env.CLEAR_RAG_ON_START !== 'false'
export const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL ?? 'claude-haiku-4-5-20251001'
export const INITIAL_FETCH_BUDGET = Number(process.env.INITIAL_WEB_FETCHES ?? 5)
export const GAP_FETCH_BUDGET = Number(process.env.GAP_WEB_FETCHES ?? 3)
export const INITIAL_SEARCH_BUDGET = Number(process.env.INITIAL_WEB_SEARCHES ?? 5)
export const GAP_SEARCH_BUDGET = Number(process.env.GAP_WEB_SEARCHES ?? 3)
export const DEFAULT_DEEP_RESEARCH = process.env.DEEP_RESEARCH === 'true'

export const AGENT_MODELS: Record<AgentName, string> = {
    researcher: process.env.RESEARCHER_MODEL ?? DEFAULT_AGENT_MODEL,
    indexer: process.env.INDEXER_MODEL ?? DEFAULT_AGENT_MODEL,
    synthesizer: process.env.SYNTHESIZER_MODEL ?? DEFAULT_AGENT_MODEL,
}

export const AGENT_TOOLSETS: Record<AgentName, string[]> = {
    researcher: ['WebSearch', 'WebFetch'],
    indexer: ['mcp__rag__index_document', 'mcp__rag__list_indexed'],
    synthesizer: ['mcp__rag__search_documents'],
}

export function getAgentPrompt(agent: AgentName): string {
    if (agent === 'researcher') return researcherDef.prompt
    if (agent === 'indexer') return indexerDef.prompt
    return synthesizerDef.prompt
}