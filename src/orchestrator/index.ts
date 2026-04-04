/**
 * Orchestrator — runs a research session with code-enforced sequencing.
 */

import { logger } from '../libs/logger.js'
import { D, R, YE } from '../libs/ansi.js'
import { parseConfidenceBlock, type ConfidenceBlock } from '../utils/index.js'
import type { IAgentRunner } from './runner/interface.js'
import { CLEAR_RAG_ON_START, DEFAULT_DEEP_RESEARCH, MAX_ITERATIONS } from './config.js'
import { buildResearchTask, buildSynthesizerPrompt, getResearchBudget, shouldStop } from './planner.js'
import { logConfidenceDecision, renderFinalAnswer } from './presenter.js'
import { dedupeResearchOutput, extractSourceUrls, indexResearchOutput, normalizeUrl, stripConfidenceBlock } from './researchOutput.js'
import type { ResearchRuntime, ResearchSessionOptions, SessionTotals } from './types.js'

export async function runResearchSession(
    question: string,
    runtime: ResearchRuntime,
    runner: IAgentRunner,
    options: ResearchSessionOptions = {}
): Promise<void> {
    const deepResearch = options.deepResearch ?? DEFAULT_DEEP_RESEARCH

    logger.info({ event: 'session.start', question, deepResearch })

    if (CLEAR_RAG_ON_START) {
        await runtime.ragStore.clearDocuments()
        logger.info({ event: 'session.rag_cleared' })
    }

    const startedAt = Date.now()
    const totals: SessionTotals = { turns: 0, costUsd: 0 }
    const previouslyCovered = new Set<string>()

    let finalAnswer = ''
    let finalConfidence: ConfidenceBlock | null = null
    let completedIterations = 0

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
        completedIterations = iteration

        const researchBudget = getResearchBudget(iteration)
        const researcherTask = buildResearchTask({
            question,
            iteration,
            previousConfidence: finalConfidence,
            previouslyCovered: [...previouslyCovered],
            budget: researchBudget,
        })
        const researcher = await runner.run('researcher', researcherTask, runtime, researchBudget)
        totals.turns += researcher.turns
        totals.costUsd += researcher.costUsd

        const dedupedResearch = dedupeResearchOutput(researcher.text, previouslyCovered)
        extractSourceUrls(dedupedResearch.text).forEach(url => previouslyCovered.add(normalizeUrl(url)))
        if (dedupedResearch.removedCount > 0) {
            console.log(`  ${D}[researcher:dedupe] removed ${dedupedResearch.removedCount} previously covered source(s)${R}`)
        }

        const sourceCount = extractSourceUrls(dedupedResearch.text).length
        if (sourceCount === 0) {
            const previousMissingTopics: string[] = finalConfidence ? finalConfidence.missingTopics : []
            finalConfidence = {
                confidence: 'low',
                missingTopics: previousMissingTopics,
                coverageNotes: 'Researcher returned no new indexable SOURCE blocks for this iteration.',
            }

            const stopping = iteration >= MAX_ITERATIONS
            console.log(`  ${YE}[orchestrator:skip]${R} ${D}no new source blocks to index; retrying without synthesizer${R}`)
            logConfidenceDecision(iteration, finalConfidence, stopping)

            if (stopping) break
            continue
        }

        const indexedCount = await indexResearchOutput(dedupedResearch.text, runtime.ragStore)
        logger.info({ event: 'indexer.done', indexed: indexedCount })

        const synthesizerPrompt = buildSynthesizerPrompt(question, iteration, finalConfidence)
        const synthesizer = await runner.run('synthesizer', synthesizerPrompt, runtime)
        totals.turns += synthesizer.turns
        totals.costUsd += synthesizer.costUsd

        finalAnswer = stripConfidenceBlock(synthesizer.text)
        finalConfidence =
            parseConfidenceBlock(synthesizer.text) ?? {
                confidence: 'low',
                missingTopics: [],
                coverageNotes: 'Synthesizer response did not include a confidence block.',
            }

        const stopping = shouldStop(iteration, finalConfidence, deepResearch)
        logConfidenceDecision(iteration, finalConfidence, stopping)

        if (stopping) break
    }

    renderFinalAnswer(finalAnswer, finalConfidence, totals, completedIterations)

    logger.info({
        event: 'session.end',
        turns: totals.turns,
        costUsd: totals.costUsd,
        iterations: completedIterations,
        durationMs: Date.now() - startedAt,
    })
}
