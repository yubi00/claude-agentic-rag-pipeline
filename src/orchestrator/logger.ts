/**
 * Structured logger for the orchestrator stream.
 *
 * Tracks iteration count and logs the synthesizer confidence decision
 * whenever the orchestrator parses it from the stream.
 */

import { R, B, D, GR, YE, RE } from '../libs/ansi.js'
import { parseConfidenceBlock } from '../utils/index.js'

export class OrchestratorLogger {
  private iteration = 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processMessage(msg: any): void {
    if (msg?.type !== 'assistant') return

    // We want to parse confidence blocks from both orchestrator-level and
    // subagent assistant messages (synthesizer may emit its JSON block from
    // a subagent). Iterate all content blocks and look for tool_use and text.
    const blocks = msg.message?.content ?? []
    for (const block of blocks) {
      if (block.type === 'tool_use') this.trackIteration(block)
      if (block.type === 'text') this.logConfidence(block.text ?? '')
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private trackIteration(block: any): void {
    if (block.name !== 'Agent' && block.name !== 'Task') return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inp = block.input as any
    const agentType: string = inp?.subagent_type ?? inp?.agentType ?? ''
    if (agentType === 'researcher') this.iteration++
  }

  private logConfidence(text: string): void {
    const confidence = parseConfidenceBlock(text)
    if (!confidence) return

    const confColor = confidence.confidence === 'high' ? GR : confidence.confidence === 'medium' ? YE : RE
    console.log(`\n${B}${confColor}[ORCHESTRATOR:decision] iter=${this.iteration} confidence=${confidence.confidence.toUpperCase()}${R}`)
    if (confidence.missingTopics.length > 0) {
      console.log(`  ${D}→ will gap-fill: ${confidence.missingTopics.join(', ')}${R}`)
    } else {
      console.log(`  ${D}→ stopping${R}`)
    }
  }
}
