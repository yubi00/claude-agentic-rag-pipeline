import type { AgentName, AgentRunResult, ResearchBudget, ResearchRuntime } from '../types.js'

export interface IAgentRunner {
    run(
        agent: AgentName,
        prompt: string,
        runtime: ResearchRuntime,
        budget?: ResearchBudget
    ): Promise<AgentRunResult>
}
