/**
 * Orchestrator — runs a single query() session with the ReAct loop.
 *
 * The ReAct loop lives INSIDE the single Claude session:
 *   THINK → ACT (researcher) → ACT (indexer) → ACT (synthesizer) → OBSERVE
 *   Repeat up to 3 iterations based on the synthesizer's confidence report.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { ragServer } from '../rag/index.js'
import { researcherDef } from '../agents/researcher.js'
import { indexerDef } from '../agents/indexer.js'
import { synthesizerDef } from '../agents/synthesizer.js'
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompt.js'
import { makeToolLimiterHooks } from './limiter.js'
import { OrchestratorLogger } from './logger.js'
import { renderMessage } from '../libs/renderer.js'
import { SESSION_TOOLS, DISALLOWED_TOOLS, ALLOWED_TOOLS } from './toolConfig.js'
import { logger } from '../libs/logger.js'

export async function runResearchSession(question: string): Promise<void> {
  logger.info({ event: 'session.start', question })
  const orchestratorLogger = new OrchestratorLogger()

  const stream = query({
    prompt: question,
    options: {
      model: process.env.ORCHESTRATOR_MODEL ?? 'claude-haiku-4-5-20251001',
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
      tools: SESSION_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      allowedTools: ALLOWED_TOOLS,
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

  const start = Date.now()

  try {
    for await (const msg of stream) {
      orchestratorLogger.processMessage(msg)
      renderMessage(msg)

      if (msg?.type === 'result' && msg.subtype === 'success') {
        logger.info({
          event: 'session.end',
          turns: msg.num_turns ?? 0,
          costUsd: msg.total_cost_usd ?? 0,
          durationMs: Date.now() - start,
        })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ event: 'session.error', err: message, durationMs: Date.now() - start })
    throw new Error(`Research session failed: ${message}`, { cause: err })
  }
}
