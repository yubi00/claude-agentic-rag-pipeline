import type { DedupedResearchResult } from './types.js'

export function extractSourceUrls(text: string): string[] {
    return [...text.matchAll(/^SOURCE:\s*(.+)$/gm)].map(match => match[1].trim())
}

export function dedupeResearchOutput(text: string, previouslyCovered: Set<string>): DedupedResearchResult {
    const blocks = text.match(/---\nSOURCE:[\s\S]*?(?=\n---\nSOURCE:|\nRESEARCH SUMMARY:|$)/g) ?? []
    if (blocks.length === 0) return { text, removedCount: 0 }

    const keptBlocks: string[] = []
    let removedCount = 0

    for (const block of blocks) {
        const urlMatch = block.match(/^SOURCE:\s*(.+)$/m)
        const normalizedUrl = normalizeUrl(urlMatch?.[1] ?? '')
        if (!normalizedUrl || previouslyCovered.has(normalizedUrl)) {
            removedCount++
            continue
        }
        keptBlocks.push(block.trim())
    }

    const summaryMatch = text.match(/RESEARCH SUMMARY:[\s\S]*$/)
    const summary = summaryMatch ? `\n\n${summaryMatch[0].trim()}` : ''

    if (keptBlocks.length === 0) {
        return {
            text: 'RESEARCH SUMMARY: No new unique sources were fetched after deduplication.',
            removedCount,
        }
    }

    return {
        text: `${keptBlocks.join('\n\n')}${summary}`,
        removedCount,
    }
}

export function normalizeUrl(url: string): string {
    const trimmed = url.trim()
    if (!trimmed) return ''

    try {
        const parsed = new URL(trimmed)
        parsed.hash = ''
        const path = parsed.pathname.replace(/\/$/, '') || '/'
        return `${parsed.origin}${path}${parsed.search}`
    } catch {
        return trimmed.replace(/\/$/, '')
    }
}

export function stripConfidenceBlock(text: string): string {
    const jsonIdx = text.lastIndexOf('```json')
    return jsonIdx > 0 ? text.slice(0, jsonIdx).trim() : text.trim()
}