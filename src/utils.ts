/**
 * Shared utilities used across renderer, logger, and agents.
 */

import { R } from './ansi.js'

// ── Terminal output ───────────────────────────────────────────────────────────

/** Print each non-empty line with a colour prefix, optionally truncating. */
export function printLines(color: string, prefix: string, text: string, maxChars = 0): void {
  const trimmed = maxChars > 0 && text.length > maxChars ? text.slice(0, maxChars) + '…' : text
  for (const line of trimmed.split('\n')) {
    if (line.trim()) console.log(`${color}${prefix}${R} ${line}`)
  }
}

// ── SDK content helpers ───────────────────────────────────────────────────────

interface ContentBlock {
  type: string
  text?: string
}

/** Concatenate all text-type content blocks into a single string. */
export function extractText(content: ContentBlock[]): string {
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('')
}

// ── Confidence block parsing ──────────────────────────────────────────────────

export interface ConfidenceBlock {
  confidence: 'high' | 'medium' | 'low'
  missingTopics: string[]
  coverageNotes: string
}

/**
 * Parse the trailing ```json confidence block from synthesizer output.
 * Returns null if not found or malformed.
 */
export function parseConfidenceBlock(text: string): ConfidenceBlock | null {
  const jsonIdx = text.lastIndexOf('```json')
  if (jsonIdx === -1) return null
  const jsonEnd = text.indexOf('```', jsonIdx + 7)
  if (jsonEnd === -1) return null

  try {
    const parsed = JSON.parse(text.slice(jsonIdx + 7, jsonEnd).trim())
    if (!('confidence' in parsed)) return null
    return {
      confidence:    parsed.confidence ?? 'low',
      missingTopics: parsed.missingTopics ?? [],
      coverageNotes: parsed.coverageNotes ?? '',
    }
  } catch {
    return null
  }
}
