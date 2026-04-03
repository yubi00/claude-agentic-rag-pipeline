/**
 * ParagraphChunker — splits text on paragraph boundaries with overlap.
 *
 * Strategy:
 *   1. Split on \n\n (natural paragraph boundaries for web content)
 *   2. Accumulate paragraphs until target size is reached → emit chunk
 *   3. Carry the last paragraph into the next chunk (overlap) so
 *      context is not lost at boundaries
 *
 * Example (targetSize=500, overlap=1 paragraph):
 *   para1 + para2 = 480 chars → chunk 0
 *   para2 + para3 = 510 chars → chunk 1  ← para2 overlaps
 *   para3 + para4 = 420 chars → chunk 2  ← para3 overlaps
 */

import type { IChunker, Chunk } from './interface.js'

export interface ParagraphChunkerOptions {
  /** Target maximum chars per chunk. Default: 500 */
  targetSize?: number
  /** Number of paragraphs to carry into the next chunk. Default: 1 */
  overlapParagraphs?: number
}

export class ParagraphChunker implements IChunker {
  private readonly targetSize: number
  private readonly overlapParagraphs: number

  constructor(options: ParagraphChunkerOptions = {}) {
    this.targetSize = options.targetSize ?? 500
    this.overlapParagraphs = options.overlapParagraphs ?? 1
  }

  chunk(text: string): Chunk[] {
    const paragraphs = text
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0)

    if (paragraphs.length === 0) return []

    const chunks: Chunk[] = []
    let current: string[] = []
    let currentSize = 0
    let chunkIndex = 0

    for (const para of paragraphs) {
      current.push(para)
      currentSize += para.length

      if (currentSize >= this.targetSize) {
        chunks.push({ content: current.join('\n\n'), index: chunkIndex++ })
        // carry last N paragraphs into the next chunk
        current = current.slice(-this.overlapParagraphs)
        currentSize = current.reduce((sum, p) => sum + p.length, 0)
      }
    }

    // flush remaining paragraphs as final chunk
    if (current.length > 0) {
      const content = current.join('\n\n')
      // avoid a duplicate chunk when the last emit and flush are identical
      const lastChunk = chunks[chunks.length - 1]
      if (!lastChunk || lastChunk.content !== content) {
        chunks.push({ content, index: chunkIndex })
      }
    }

    return chunks
  }
}
