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
import { initializeRagRuntime } from './rag/index.js'

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim()

  if (!question) {
    console.error('\nUsage:  npx tsx src/index.ts "your research question"')
    console.error('Example: npx tsx src/index.ts "What are the latest advances in quantum computing?"')
    process.exit(1)
  }

  const deepResearch = process.env.DEEP_RESEARCH === 'true'

  console.log(`\nResearching: "${question}"\n`)
  console.log(`Mode: deepResearch=${deepResearch}\n`)

  const agentProvider = process.env.AGENT_PROVIDER || 'vercel'
  console.log(`Using agent provider: ${agentProvider}\n`)

  const runtime = await initializeRagRuntime()
  const runner = agentProvider === 'vercel' ? new VercelAgentRunner() : new ClaudeAgentRunner()
  await runResearchSession(question, runtime, runner, { deepResearch })
}

main().catch(err => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
