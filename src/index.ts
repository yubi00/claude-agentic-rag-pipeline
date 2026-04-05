/**
 * CLI entry point.
 *
 * Usage:
 *   npx tsx src/index.ts "your research question here"
 *   npm run ask "your research question here"
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import { runResearchSession } from './orchestrator/index.js'
import { ClaudeAgentRunner } from './orchestrator/runner/claudeAgentRunner.js'
import { VercelAgentRunner } from './orchestrator/runner/vercelAgentRunner.js'
import { LangChainAgentRunner } from './orchestrator/runner/langchainAgentRunner.js'
import { StrandsAgentRunner } from './orchestrator/runner/strandsAgentRunner.js'
import { initializeRagRuntime } from './rag/index.js'
import { AGENT_PROVIDER, DEFAULT_DEEP_RESEARCH, validateEnv } from './config/env.js'
import { RE, R } from './libs/ansi.js'

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim()

  if (!question) {
    console.error('\nUsage:  npx tsx src/index.ts "your research question"')
    console.error('Example: npx tsx src/index.ts "What are the latest advances in quantum computing?"')
    process.exit(1)
  }

  validateEnv()

  console.log(`\nResearching: "${question}"\n`)
  console.log(`Mode: deepResearch=${DEFAULT_DEEP_RESEARCH}\n`)
  console.log(`Using agent provider: ${AGENT_PROVIDER}\n`)

  const runtime = await initializeRagRuntime()
  const runner =
    AGENT_PROVIDER === 'vercel' ? new VercelAgentRunner() :
    AGENT_PROVIDER === 'langchain' ? new LangChainAgentRunner() :
    AGENT_PROVIDER === 'strands' ? new StrandsAgentRunner() :
    new ClaudeAgentRunner()
  await runResearchSession(question, runtime, runner, { deepResearch: DEFAULT_DEEP_RESEARCH })
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`\n${RE}[ERROR]${R} ${msg}`)
  process.exit(1)
})
