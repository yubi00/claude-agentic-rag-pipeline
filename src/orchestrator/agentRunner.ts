import { query } from '@anthropic-ai/claude-agent-sdk'
import { makeToolLimiterHooks } from './limiter.js'
import { BLOCKED_CONTEXT_TOOLS } from './toolConfig.js'
import { AGENT_MODELS, AGENT_TOOLSETS, getAgentPrompt } from './config.js'
import { renderAgentMessage, renderAgentStart } from './presenter.js'
import type { AgentName, AgentRunResult, ResearchBudget, ResearchRuntime, SdkResultMessage, SdkStreamMessage } from './types.js'

export async function runAgent(
    agent: AgentName,
    prompt: string,
    runtime: ResearchRuntime,
    researchBudget?: ResearchBudget
): Promise<AgentRunResult> {
    renderAgentStart(agent)

    const stream = query({
        prompt,
        options: {
            model: AGENT_MODELS[agent],
            systemPrompt: getAgentPrompt(agent),
            tools: AGENT_TOOLSETS[agent],
            allowedTools: AGENT_TOOLSETS[agent],
            disallowedTools: BLOCKED_CONTEXT_TOOLS,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            persistSession: false,
            maxTurns: agent === 'synthesizer' ? 16 : 12,
            hooks: agent === 'researcher'
                ? makeToolLimiterHooks({
                    maxWebFetches: researchBudget?.maxFetchesTotal,
                    maxWebSearches: researchBudget?.maxSearchesTotal,
                })
                : undefined,
            mcpServers: agent === 'researcher' ? undefined : { rag: runtime.ragServer },
        },
    })

    const startedAt = Date.now()
    let finalText = ''
    let turns = 0
    let costUsd = 0

    for await (const msg of stream as AsyncIterable<SdkStreamMessage>) {
        renderAgentMessage(agent, msg)

        if (isSuccessResult(msg)) {
            finalText = String(msg.result ?? '')
            turns = Number(msg.num_turns ?? 0)
            costUsd = Number(msg.total_cost_usd ?? 0)
        }
    }

    return {
        text: finalText,
        turns,
        costUsd,
        durationMs: Date.now() - startedAt,
    }
}

function isSuccessResult(msg: SdkStreamMessage): msg is SdkResultMessage {
    return msg.type === 'result' && msg.subtype === 'success'
}