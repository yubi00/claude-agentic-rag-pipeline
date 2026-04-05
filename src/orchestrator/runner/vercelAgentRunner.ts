import { ToolLoopAgent, stepCountIs } from 'ai'
import { google } from '@ai-sdk/google'
import { AGENT_COLORS, B, D, R, RE } from '../../libs/ansi.js'
import { getAgentPrompt } from '../config.js'
import { renderAgentStart } from '../presenter.js'
import { logger } from '../../libs/logger.js'
import { buildResearcherTools, buildSynthesizerTools } from './vercelTools.js'
import type { AgentName, AgentRunResult, ResearchBudget, ResearchRuntime } from '../types.js'
import type { IAgentRunner } from './interface.js'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

// Gemini Flash 2.5 pricing (per 1M tokens)
const INPUT_COST_PER_M = 0.10
const OUTPUT_COST_PER_M = 0.40

export class VercelAgentRunner implements IAgentRunner {
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
        const researcherCtx = agent === 'researcher' ? buildResearcherTools(color, budget, runtime.ragStore) : null
        const tools = researcherCtx?.tools ?? buildSynthesizerTools(agent, runtime)

        const budgetStop = researcherCtx
            ? (_opts: { steps: unknown[] }) => researcherCtx.isBudgetExhausted()
            : null

        const agentInstance = new ToolLoopAgent({
            model: google(GEMINI_MODEL),
            instructions: getAgentPrompt(agent),
            tools,
            stopWhen: budgetStop ? [stepCountIs(maxSteps), budgetStop] : stepCountIs(maxSteps),
            onStepFinish: (step) => {
                const called = step.toolCalls.map(tc => tc.toolName).join(', ')
                if (called) console.log(`  ${D}[${agent}:step ${step.stepNumber + 1}] tools: ${called}${R}`)
            },
        })

        let result: Awaited<ReturnType<typeof agentInstance.generate>>
        try {
            result = await agentInstance.generate({ prompt })
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(`\n  ${RE}[${agent}:ERROR]${R} ${msg}`)
            logger.error({ event: 'agent.error', agent, model: GEMINI_MODEL, err: msg })
            throw err
        }

        const { inputTokens = 0, outputTokens = 0 } = result.totalUsage
        const costUsd = (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M

        console.log(`  ${D}[${agent}] ${B}done${R} ${D}${result.steps.length} step(s) | ${inputTokens + outputTokens} tokens${R}`)

        return {
            text: result.text,
            turns: result.steps.length,
            costUsd,
            durationMs: Date.now() - startedAt,
            failedUrls: researcherCtx?.failedUrls,
            indexedCount: researcherCtx?.getIndexedCount(),
        }
    }
}
