/**
 * Orchestrator — runs a single query() session with the ReAct loop.
 *
 * The ReAct loop lives INSIDE the single Claude session:
 *   THINK → ACT (researcher) → ACT (indexer) → ACT (synthesizer) → OBSERVE
 *   Repeat up to 3 iterations based on the synthesizer's confidence report.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { ragServer } from './rag-server.js'
import { researcherDef } from './agents/researcher.js'
import { indexerDef } from './agents/indexer.js'
import { synthesizerDef } from './agents/synthesizer.js'
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompt.js'
import { makeToolLimiterHooks } from './limiter.js'
import { OrchestratorLogger } from './logger.js'
import { renderMessage } from './renderer.js'

export async function runResearchSession(question: string): Promise<void> {
  const logger = new OrchestratorLogger()

  const stream = query({
    prompt: question,
    options: {
      model: process.env.ORCHESTRATOR_MODEL ?? 'claude-haiku-4-5-20251001',
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      allowedTools: ['Agent'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: makeToolLimiterHooks(),
      persistSession: false,
      maxTurns: 15,
      agents: {
        researcher: researcherDef,
        indexer: indexerDef,
        synthesizer: synthesizerDef,
      },
      mcpServers: {
        rag: ragServer,
      },
    },
  })

  for await (const msg of stream) {
    logger.processMessage(msg)
    renderMessage(msg)
  }
}
