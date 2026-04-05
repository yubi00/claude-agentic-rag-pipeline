/**
 * Central environment variable config.
 * All process.env access should go through here.
 */

function required(key: string): string {
    const value = process.env[key]
    if (!value) throw new Error(`Missing required environment variable: ${key}`)
    return value
}

function optional(key: string, defaultValue: string): string {
    return process.env[key] ?? defaultValue
}

// --- Provider ---
export const AGENT_PROVIDER = optional('AGENT_PROVIDER', 'vercel')

// --- API Keys (optional at load time — validated when the runner actually uses them) ---
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
export const GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY
export const TAVILY_API_KEY = process.env.TAVILY_API_KEY
export const DATABASE_URL = process.env.DATABASE_URL

/**
 * Call this at startup to eagerly validate all keys required by the active provider.
 * Throws a clear error before any agent work begins.
 */
export function validateEnv(): void {
    required('DATABASE_URL')

    if (AGENT_PROVIDER === 'claude') {
        required('ANTHROPIC_API_KEY')
    } else if (AGENT_PROVIDER === 'vercel' || AGENT_PROVIDER === 'langchain') {
        required('GOOGLE_GENERATIVE_AI_API_KEY')
        required('TAVILY_API_KEY')
    }
}

// --- Models ---
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
export const DEFAULT_AGENT_MODEL = process.env.AGENT_MODEL ?? 'claude-haiku-4-5-20251001'
export const RESEARCHER_MODEL = process.env.RESEARCHER_MODEL ?? DEFAULT_AGENT_MODEL
export const SYNTHESIZER_MODEL = process.env.SYNTHESIZER_MODEL ?? DEFAULT_AGENT_MODEL

// --- Orchestrator ---
export const MAX_ITERATIONS = Number(process.env.MAX_RESEARCH_ITERATIONS ?? 3)
export const CLEAR_RAG_ON_START = process.env.CLEAR_RAG_ON_START !== 'false'
export const DEFAULT_DEEP_RESEARCH = process.env.DEEP_RESEARCH === 'true'

// --- Research budgets ---
export const INITIAL_FETCH_BUDGET = Number(process.env.INITIAL_WEB_FETCHES ?? 5)
export const GAP_FETCH_BUDGET = Number(process.env.GAP_WEB_FETCHES ?? 3)
export const INITIAL_SEARCH_BUDGET = Number(process.env.INITIAL_WEB_SEARCHES ?? 5)
export const GAP_SEARCH_BUDGET = Number(process.env.GAP_WEB_SEARCHES ?? 3)

// --- Logging ---
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
export const NODE_ENV = process.env.NODE_ENV ?? 'development'
