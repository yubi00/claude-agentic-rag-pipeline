import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { createAgent } from 'langchain'
import { AGENT_COLORS, B, D, R, RE } from '../../libs/ansi.js'
import { getAgentPrompt } from '../config.js'
import { renderAgentStart } from '../presenter.js'
import { logger } from '../../libs/logger.js'
import { createWebSearchTool } from './tools/langchain/webSearchTool.js'
import { createWebFetchTool } from './tools/langchain/webFetchTool.js'
import { createSearchDocumentsTool } from './tools/langchain/searchDocumentsTool.js'
import type { AgentName, AgentRunResult, ResearchBudget, ResearchRuntime } from '../types.js'
import type { IAgentRunner } from './interface.js'

import { GEMINI_MODEL, GOOGLE_GENERATIVE_AI_API_KEY } from '../../config/env.js'

// Gemini Flash 2.5 pricing (per 1M tokens)
const INPUT_COST_PER_M = 0.10
const OUTPUT_COST_PER_M = 0.40

export class LangChainAgentRunner implements IAgentRunner {
    async run(
        agent: AgentName,
        prompt: string,
        runtime: ResearchRuntime,
        budget?: ResearchBudget
    ): Promise<AgentRunResult> {
        renderAgentStart(agent)

        const color = AGENT_COLORS[agent] ?? ''
        const startedAt = Date.now()
        const maxSteps = agent === 'synthesizer' ? 16 : 12

        const failedUrls = new Set<string>()
        const indexedUrls = new Set<string>()
        const usage = { searches: 0, fetches: 0, indexed: 0 }
        const maxSearches = budget?.maxSearchesTotal ?? Infinity
        const maxFetches = budget?.maxFetchesTotal ?? Infinity

        const tools = agent === 'researcher'
            ? [
                createWebSearchTool(color, usage, maxSearches, runtime.ragStore, indexedUrls),
                createWebFetchTool(color, usage, maxFetches, failedUrls, runtime.ragStore, indexedUrls),
            ]
            : [
                createSearchDocumentsTool(agent, runtime),
            ]

        const model = new ChatGoogleGenerativeAI({
            model: GEMINI_MODEL,
            temperature: 0,
            apiKey: GOOGLE_GENERATIVE_AI_API_KEY,
        })

        const systemPrompt = getAgentPrompt(agent)

        try {
            const agentInstance = createAgent({
                model,
                tools,
                systemPrompt,
            })

            let steps = 0
            let inputTokens = 0
            let outputTokens = 0

            // Synthesizer: append explicit JSON block reminder to the human message.
            // Gemini in LangChain ReAct mode doesn't reliably follow system-only trailing
            // instructions, so we reinforce it in the user turn too.
            const humanContent = agent === 'synthesizer'
                ? `${prompt}\n\nIMPORTANT: After your complete answer, you MUST append the JSON confidence block exactly as shown in your instructions. It must be the LAST thing in your response.`
                : prompt

            const result = await agentInstance.invoke(
                { messages: [{ role: 'user', content: humanContent }] },
                {
                    recursionLimit: maxSteps * 2,
                    callbacks: [{
                        handleLLMEnd(output: { llmOutput?: Record<string, unknown> }) {
                            const u = (output.llmOutput?.usageMetadata ?? output.llmOutput?.tokenUsage) as Record<string, number> | undefined
                            inputTokens += u?.inputTokenCount ?? u?.input_tokens ?? u?.promptTokens ?? 0
                            outputTokens += u?.outputTokenCount ?? u?.output_tokens ?? u?.completionTokens ?? 0
                        },
                        handleToolStart() {
                            steps++
                            console.log(`  ${D}[${agent}:step ${steps}]${R}`)
                        },
                    }],
                }
            )

            const lastMessage = result.messages.at(-1)
            const content = lastMessage?.content
            const text = typeof content === 'string'
                ? content
                : Array.isArray(content)
                    ? content.map((b) => (typeof b === 'string' ? b : (('text' in b && typeof b.text === 'string') ? b.text : ''))).join('')
                    : String(content ?? '')

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
            const msg = err instanceof Error ? err.message : String(err)
            const stack = err instanceof Error ? err.stack : undefined
            console.error(`\n  ${RE}[langchain:${agent}:ERROR]${R} ${msg}`)
            if (stack) console.error(`  ${RE}${stack}${R}`)
            logger.error({ event: 'agent.error', runner: 'langchain', agent, model: GEMINI_MODEL, err: msg })
            throw err
        }
    }
}
