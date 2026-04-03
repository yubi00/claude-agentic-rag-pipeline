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

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim()

  if (!question) {
    console.error('\nUsage:  npx tsx src/index.ts "your research question"')
    console.error('Example: npx tsx src/index.ts "What are the latest advances in quantum computing?"')
    process.exit(1)
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nError: ANTHROPIC_API_KEY environment variable is not set.')
    console.error('Set it with: export ANTHROPIC_API_KEY=sk-ant-...')
    process.exit(1)
  }

  const deepResearch = process.env.DEEP_RESEARCH === 'true'

  console.log(`\nResearching: "${question}"\n`)
  console.log(`Mode: deepResearch=${deepResearch}\n`)

  await runResearchSession(question, { deepResearch })
}

main().catch(err => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
