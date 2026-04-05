import { researcherDef } from '../agents/researcher.js'
import { synthesizerDef } from '../agents/synthesizer.js'
import {
    DEFAULT_AGENT_MODEL,
    RESEARCHER_MODEL,
    SYNTHESIZER_MODEL,
    MAX_ITERATIONS,
    CLEAR_RAG_ON_START,
    DEFAULT_DEEP_RESEARCH,
    INITIAL_FETCH_BUDGET,
    GAP_FETCH_BUDGET,
    INITIAL_SEARCH_BUDGET,
    GAP_SEARCH_BUDGET,
} from '../config/env.js'
import type { AgentName } from './types.js'

export {
    MAX_ITERATIONS,
    CLEAR_RAG_ON_START,
    DEFAULT_AGENT_MODEL,
    DEFAULT_DEEP_RESEARCH,
    INITIAL_FETCH_BUDGET,
    GAP_FETCH_BUDGET,
    INITIAL_SEARCH_BUDGET,
    GAP_SEARCH_BUDGET,
}

export const AGENT_MODELS: Record<AgentName, string> = {
    researcher: RESEARCHER_MODEL,
    synthesizer: SYNTHESIZER_MODEL,
}

export const AGENT_TOOLSETS: Record<AgentName, string[]> = {
    researcher: ['WebSearch', 'WebFetch'],
    synthesizer: ['mcp__rag__search_documents'],
}

export function getAgentPrompt(agent: AgentName): string {
    if (agent === 'researcher') return researcherDef.prompt
    return synthesizerDef.prompt
}
