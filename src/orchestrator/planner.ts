import type { ConfidenceBlock } from '../utils/index.js'
import {
    GAP_FETCH_BUDGET,
    GAP_SEARCH_BUDGET,
    INITIAL_FETCH_BUDGET,
    INITIAL_SEARCH_BUDGET,
    MAX_ITERATIONS,
} from './config.js'
import type { ResearchBudget, ResearchIterationContext } from './types.js'

export function buildResearchTask(context: ResearchIterationContext): string {
    const { question, iteration, previousConfidence, previouslyCovered, budget } = context

    if (iteration === 1 || !previousConfidence || previousConfidence.missingTopics.length === 0) {
        return JSON.stringify(
            {
                queries: buildInitialQueries(question),
                context: `initial research for: ${question}`,
                isGapFilling: false,
                previouslyCovered,
                maxFetchesTotal: budget.maxFetchesTotal,
            },
            null,
            2
        )
    }

    return JSON.stringify(
        {
            queries: buildGapQueries(question, previousConfidence),
            context: `gap filling for: ${question}`,
            isGapFilling: true,
            previouslyCovered,
            maxFetchesTotal: budget.maxFetchesTotal,
        },
        null,
        2
    )
}

export function getResearchBudget(iteration: number): ResearchBudget {
    if (iteration <= 1) {
        return {
            maxFetchesTotal: INITIAL_FETCH_BUDGET,
            maxSearchesTotal: INITIAL_SEARCH_BUDGET,
        }
    }

    return {
        maxFetchesTotal: GAP_FETCH_BUDGET,
        maxSearchesTotal: GAP_SEARCH_BUDGET,
    }
}

export function buildSynthesizerPrompt(
    question: string,
    iteration: number,
    previousConfidence: ConfidenceBlock | null
): string {
    if (iteration === 1 || !previousConfidence || previousConfidence.missingTopics.length === 0) {
        return question
    }

    return `KNOWN GAPS: ${previousConfidence.missingTopics.join(', ')}\n\nQuestion: ${question}`
}

export function shouldStop(iteration: number, confidence: ConfidenceBlock, deepResearch: boolean): boolean {
    if (iteration >= MAX_ITERATIONS) return true

    if (deepResearch) {
        return confidence.confidence === 'high'
    }

    return confidence.confidence !== 'low'
}

function buildInitialQueries(question: string): string[] {
    const normalized = question.trim().replace(/[?.!]+$/, '')
    const queries = new Set<string>([normalized])

    if (/\b(today|latest|recent|current|this week|this weekend|tonight)\b/i.test(normalized)) {
        queries.add(`${normalized} official sources`)
    } else {
        queries.add(`${normalized} guide`)
    }

    return [...queries].slice(0, 2)
}

function buildGapQueries(question: string, confidence: ConfidenceBlock): string[] {
    const subjectHint = extractSubjectHint(question)
    const queries = new Set<string>()

    for (const topic of confidence.missingTopics.slice(0, 3)) {
        const normalizedTopic = topic.trim()
        if (!normalizedTopic) continue

        queries.add(`${normalizedTopic} ${subjectHint}`.trim())

        if (/opening hours|hours|times/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} official opening hours`)
        } else if (/price|pricing|admission|ticket|fee|cost/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} official ticket prices`)
        } else if (/history|historical|colonial|landmark/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} historical landmarks guide`)
        } else if (/museum|gallery|art/i.test(normalizedTopic)) {
            queries.add(`${subjectHint} art galleries museums`)
        }
    }

    if (queries.size === 0) {
        queries.add(`${question.trim().replace(/[?.!]+$/, '')} official sources`)
    }

    return [...queries].slice(0, 3)
}

function extractSubjectHint(question: string): string {
    return question
        .replace(/^can you tell me|^what are|^what is|^find|^show me/gi, '')
        .replace(/\b(top|best|five|places|visit|events|happening|this weekend|today|latest|current)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim() || question.trim()
}