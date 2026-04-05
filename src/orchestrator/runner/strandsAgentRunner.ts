import { Agent, BeforeToolCallEvent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { AGENT_COLORS, B, D, R, RE } from '../../libs/ansi.js'
import { getAgentPrompt } from '../config.js'
import { renderAgentStart } from '../presenter.js'
import { logger } from '../../libs/logger.js'
import { createWebSearchTool } from './tools/strands/webSearchTool.js'
import { createWebFetchTool } from './tools/strands/webFetchTool.js'
import { createSearchDocumentsTool } from './tools/strands/searchDocumentsTool.js'
import type { AgentName, AgentRunResult, ResearchBudget, ResearchRuntime } from '../types.js'
import type { IAgentRunner } from './interface.js'
import { OPENAI_API_KEY, OPENAI_MODEL } from '../../config/env.js'

// gpt-4o-mini pricing (per 1M tokens)
const INPUT_COST_PER_M = 0.15
const OUTPUT_COST_PER_M = 0.60

export class StrandsAgentRunner implements IAgentRunner {
    async run(
        agent: AgentName,
        prompt: string,
        runtime: ResearchRuntime,
        budget?: ResearchBudget
    ): Promise<AgentRunResult> {
        renderAgentStart(agent)

        const color = AGENT_COLORS[agent] ?? ''
        const startedAt = Date.now()

        const failedUrls = new Set<string>()
        const indexedUrls = new Set<string>()
        const usage = { searches: 0, fetches: 0, indexed: 0 }
        const maxSearches = budget?.maxSearchesTotal ?? Infinity
        const maxFetches = budget?.maxFetchesTotal ?? Infinity

        const tools = agent === 'researcher'
            ? [
                createWebSearchTool(color, usage, indexedUrls, runtime.ragStore),
                createWebFetchTool(color, usage, failedUrls, indexedUrls, runtime.ragStore),
            ]
            : [
                createSearchDocumentsTool(agent, runtime),
            ]

        const model = new OpenAIModel({
            api: 'chat',
            modelId: OPENAI_MODEL,
            apiKey: OPENAI_API_KEY,
            temperature: 0,
        })

        const agentInstance = new Agent({
            model,
            tools,
            systemPrompt: getAgentPrompt(agent),
            printer: false,   // disable Strands' built-in console output — we have our own
        })

        // Hard budget stop — cancel the tool call before it runs when budget is spent.
        // BeforeToolCallEvent.cancel can be set to a string (used as the tool error result)
        // or true (uses a default cancel message). This fires BEFORE the tool callback,
        // giving us a proper framework-level stop rather than relying on the model to honour
        // an "exhausted" string returned from inside the tool.
        let steps = 0
        const cleanupHook = agentInstance.addHook(BeforeToolCallEvent, (event) => {
            if (event.toolUse.name === 'WebSearch' && usage.searches >= maxSearches) {
                event.cancel = 'Search budget exhausted — no more web searches allowed.'
            } else if (event.toolUse.name === 'WebFetch' && usage.fetches >= maxFetches) {
                event.cancel = 'Fetch budget exhausted — no more page fetches allowed.'
            } else {
                steps++
                console.log(`  ${D}[${agent}:step ${steps}]${R}`)
            }
        })

        try {
            const result = await agentInstance.invoke(prompt)

            cleanupHook()

            const text = result.toString()
            const inputTokens = result.metrics?.accumulatedUsage.inputTokens ?? 0
            const outputTokens = result.metrics?.accumulatedUsage.outputTokens ?? 0
            const costUsd = (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M

            console.log(`  ${D}[${agent}] ${B}done${R} ${D}${steps} step(s) | ${inputTokens + outputTokens} tokens${R}`)

            return {
                text,
                turns: steps,
                costUsd,
                durationMs: Date.now() - startedAt,
                failedUrls: agent === 'researcher' ? failedUrls : undefined,
                indexedCount: agent === 'researcher' ? usage.indexed : undefined,
            }
        } catch (err) {
            cleanupHook()
            const msg = err instanceof Error ? err.message : String(err)
            const stack = err instanceof Error ? err.stack : undefined
            console.error(`\n  ${RE}[strands:${agent}:ERROR]${R} ${msg}`)
            if (stack) console.error(`  ${RE}${stack}${R}`)
            logger.error({ event: 'agent.error', runner: 'strands', agent, model: OPENAI_MODEL, err: msg })
            throw err
        }
    }
}
