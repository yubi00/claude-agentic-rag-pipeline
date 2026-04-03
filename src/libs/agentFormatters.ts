/**
 * Agent-specific text formatters.
 *
 * Each formatter handles the output of one subagent type.
 * Register new agents here — renderer.ts never needs to change.
 *
 * Contract: (text: string) => void
 *   text  — the full text block emitted by the agent
 */

import { R, GR, YE, RE, B, D, AGENT_COLORS } from './ansi.js'
import { printLines, parseConfidenceBlock } from '../utils/index.js'

// ── Individual formatters ─────────────────────────────────────────────────────

function formatResearcher(text: string): void {
  const color = AGENT_COLORS['researcher']
  const firstLine = text.split('\n').find(l => l.trim()) ?? ''
  if (firstLine) printLines(color, '  [researcher]', firstLine.slice(0, 120))

  const sourceCount = (text.match(/^SOURCE:/gm) ?? []).length
  if (sourceCount > 0) {
    console.log(`  ${color}[researcher:sources]${R} Fetched ${B}${sourceCount}${R} source(s)`)
  }

  const summary = text.match(/RESEARCH SUMMARY:(.+?)(?:\n|$)/)
  if (summary) console.log(`  ${color}[researcher:summary]${R} ${summary[1].trim()}`)
}

function formatIndexer(text: string): void {
  const color = AGENT_COLORS['indexer']

  const indexed = text.match(/INDEXED:\s*(\d+)\s*document/i)
  if (indexed) {
    console.log(`  ${color}[indexer:indexed]${R} ${B}${indexed[1]}${R} document(s) added to knowledge base`)
  }

  const total = text.match(/KNOWLEDGE BASE TOTAL:\s*(\d+)/i)
  if (total) {
    console.log(`  ${color}[indexer:kb_total]${R} Knowledge base now has ${B}${total[1]}${R} document(s)`)
  }
}

function formatSynthesizer(text: string): void {
  const color = AGENT_COLORS['synthesizer']
  const jsonIdx = text.lastIndexOf('```json')
  const displayText = jsonIdx > 0 ? text.slice(0, jsonIdx).trim() : text
  if (displayText) printLines(color, '  [synthesizer]', displayText, 300)

  const confidence = parseConfidenceBlock(text)
  if (!confidence) return

  const confColor = confidence.confidence === 'high' ? GR : confidence.confidence === 'medium' ? YE : RE
  console.log(`\n  ${B}${confColor}[CONFIDENCE: ${confidence.confidence.toUpperCase()}]${R}`)
  if (confidence.coverageNotes) console.log(`  ${D}  coverage: ${confidence.coverageNotes}${R}`)
  if (confidence.missingTopics.length > 0) {
    console.log(`  ${YE}  missing topics (${confidence.missingTopics.length}): ${confidence.missingTopics.join(', ')}${R}`)
  }
  console.log()
}

// ── Registry ──────────────────────────────────────────────────────────────────

/** Maps agent name → its text formatter. Add new agents here. */
export const AGENT_FORMATTERS: Record<string, (text: string) => void> = {
  researcher:  formatResearcher,
  indexer:     formatIndexer,
  synthesizer: formatSynthesizer,
}
