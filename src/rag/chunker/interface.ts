/**
 * IChunker — contract every chunking strategy must satisfy.
 *
 * Swap strategies in rag/chunker/index.ts without touching the stores.
 */

export interface Chunk {
  content: string
  /** 0-based position of this chunk within the parent document. */
  index: number
}

export interface IChunker {
  chunk(text: string): Chunk[]
}
