import type { ConfidenceBlock } from '../utils/index.js'
import type { RagRuntime } from '../rag/index.js'

export type AgentName = 'researcher' | 'synthesizer'
export type JsonRecord = Record<string, unknown>

export interface AgentRunResult {
    text: string
    turns: number
    costUsd: number
    durationMs: number
    failedUrls?: Set<string>
}

export interface SessionTotals {
    turns: number
    costUsd: number
}

export interface DedupedResearchResult {
    text: string
    removedCount: number
}

export interface ResearchBudget {
    maxFetchesTotal: number
    maxSearchesTotal: number
}

export interface ResearchSessionOptions {
    deepResearch?: boolean
}

export type ResearchRuntime = RagRuntime

export interface ResearchIterationContext {
    question: string
    iteration: number
    previousConfidence: ConfidenceBlock | null
    previouslyCovered: string[]
    budget: ResearchBudget
}

export interface SdkUsage {
    tool_uses?: number
    toolUses?: number
    total_tokens?: number
    totalTokens?: number
    duration_ms?: number
    durationMs?: number
}

export interface SdkThinkingBlock {
    type: 'thinking'
    thinking?: string
}

export interface SdkTextBlock {
    type: 'text'
    text?: string
}

export interface SdkToolUseBlock {
    type: 'tool_use'
    name?: string
    input?: JsonRecord
}

export type SdkAssistantBlock = SdkThinkingBlock | SdkTextBlock | SdkToolUseBlock

export interface SdkSystemMessage {
    type: 'system'
    subtype?: 'task_started' | 'task_progress' | string
    description?: string
    task_description?: string
    usage?: SdkUsage
    cumulative_usage?: SdkUsage
    summary?: string
}

export interface SdkAssistantMessage {
    type: 'assistant'
    message?: {
        content?: SdkAssistantBlock[]
    }
}

export interface SdkToolProgressMessage {
    type: 'tool_progress'
    tool_name?: string
    tool_input?: JsonRecord
}

export interface SdkToolResultContentBlock {
    type: string
    text?: string
}

export interface SdkToolResultMessage {
    type: 'tool_result'
    tool_name?: string
    status?: string
    tool_status?: string
    content?: SdkToolResultContentBlock[]
    error?: string
    error_message?: string
}

export interface SdkResultMessage {
    type: 'result'
    subtype?: 'success' | string
    result?: string
    num_turns?: number
    total_cost_usd?: number
    errors?: string[]
}

export type SdkStreamMessage =
    | SdkSystemMessage
    | SdkAssistantMessage
    | SdkToolProgressMessage
    | SdkToolResultMessage
    | SdkResultMessage