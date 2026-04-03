/**
 * Active chunker configuration — swap strategy here, nothing else changes.
 *
 * ─── Option A: Paragraph-based with overlap (default) ────────────────────────
 *   export const defaultChunker = new ParagraphChunker()
 *
 * ─── Option B: Smaller chunks for denser retrieval ───────────────────────────
 *   export const defaultChunker = new ParagraphChunker({ targetSize: 300, overlapParagraphs: 2 })
 *
 * ─── Option C: Your own strategy ─────────────────────────────────────────────
 *   export class SentenceChunker implements IChunker { ... }
 *   export const defaultChunker = new SentenceChunker()
 */

export type { IChunker, Chunk } from './interface.js'
export { ParagraphChunker } from './paragraph-chunker.js'

import { ParagraphChunker } from './paragraph-chunker.js'

export const defaultChunker = new ParagraphChunker()
