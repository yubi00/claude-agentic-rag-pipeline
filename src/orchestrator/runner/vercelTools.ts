import { createWebSearchTool } from './tools/webSearchTool.js'
import { createWebFetchTool } from './tools/webFetchTool.js'
import { createSearchDocumentsTool } from './tools/searchDocumentsTool.js'
import type { AgentName, ResearchBudget, ResearchRuntime } from '../types.js'
import type { IRagStore } from '../../rag/interface.js'

export interface ResearcherToolContext {
    tools: ReturnType<typeof buildResearcherToolset>
    failedUrls: Set<string>
    isBudgetExhausted: () => boolean
    getIndexedCount: () => number
}

export function buildResearcherTools(color: string, budget?: ResearchBudget, ragStore?: IRagStore): ResearcherToolContext {
    const failedUrls = new Set<string>()
    const usage = { searches: 0, fetches: 0, indexed: 0 }
    const maxSearches = budget?.maxSearchesTotal ?? Infinity
    const maxFetches = budget?.maxFetchesTotal ?? Infinity
    return {
        tools: buildResearcherToolset(color, budget, failedUrls, usage, ragStore),
        failedUrls,
        isBudgetExhausted: () => usage.searches >= maxSearches && usage.fetches >= maxFetches,
        getIndexedCount: () => usage.indexed,
    }
}

function buildResearcherToolset(
    color: string,
    budget: ResearchBudget | undefined,
    failedUrls: Set<string>,
    usage: { searches: number; fetches: number; indexed: number },
    ragStore?: IRagStore
) {
    const maxSearches = budget?.maxSearchesTotal ?? Infinity
    const maxFetches = budget?.maxFetchesTotal ?? Infinity

    return {
        WebSearch: createWebSearchTool(color, usage, maxSearches, ragStore),
        WebFetch: createWebFetchTool(color, usage, maxFetches, failedUrls, ragStore),
    }
}

export function buildSynthesizerTools(agent: AgentName, runtime: ResearchRuntime) {
    return {
        search_documents: createSearchDocumentsTool(agent, runtime),
    }
}
