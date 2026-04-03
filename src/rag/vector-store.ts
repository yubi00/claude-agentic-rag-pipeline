/**
 * VectorStore — semantic similarity search backend.
 *
 * Implements IRagStore using dense vector embeddings + cosine similarity.
 * Documents are split into chunks by the injected IChunker — each chunk
 * gets its own embedding, enabling fine-grained semantic retrieval.
 *
 * The embedding function is injected at construction time — plug in any provider:
 *
 *   // Local (no API key, model downloads on first use ~25 MB):
 *   import { createLocalEmbedder } from './vector-store.js'
 *   const store = new VectorStore(await createLocalEmbedder())
 *
 *   // OpenAI:
 *   const store = new VectorStore(async (text) => {
 *     const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
 *     return res.data[0].embedding
 *   })
 *
 *   // Cohere, Voyage, etc. — same pattern.
 */

import type { IRagStore, SearchResult, AddDocumentResult } from './interface.js'
import type { IChunker } from './chunker/index.js'
import { defaultChunker } from './chunker/index.js'
import { EmbedError, StoreError } from './errors.js'
import { logger } from '../libs/logger.js'

// ── Embed function contract ───────────────────────────────────────────────────

/** Any function that maps a string → a fixed-length float vector. */
export type EmbedFn = (text: string) => Promise<number[]>

// ── Internal types ────────────────────────────────────────────────────────────

interface VectorChunk {
  docId: number
  chunkIndex: number
  title: string
  url: string
  content: string
  embedding: number[]
}

const EXCERPT_LENGTH = 500

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ── Implementation ────────────────────────────────────────────────────────────

export class VectorStore implements IRagStore {
  private docCount = 0
  private readonly chunks: VectorChunk[] = []
  private readonly registry = new Map<number, { title: string; url: string }>()

  constructor(
    private readonly embed: EmbedFn,
    private readonly chunker: IChunker = defaultChunker
  ) {}

  async addDocument(params: {
    title?: string
    url?: string
    content: string
  }): Promise<AddDocumentResult> {
    const docId = ++this.docCount
    const title = params.title ?? `Document ${docId}`
    const url = params.url ?? ''

    this.registry.set(docId, { title, url })

    const chunks = this.chunker.chunk(params.content)

    // Embed chunks in parallel
    try {
      await Promise.all(
        chunks.map(async chunk => {
          const embedding = await this.embed(`${title}\n\n${chunk.content}`)
          this.chunks.push({ docId, chunkIndex: chunk.index, title, url, content: chunk.content, embedding })
        })
      )
    } catch (err) {
      this.registry.delete(docId)
      this.docCount--
      if (err instanceof EmbedError) throw err
      throw new EmbedError(`Failed to embed document "${title}"`, err)
    }

    const result = { id: docId, title, contentLength: params.content.length, chunkCount: chunks.length }
    logger.info({ event: 'doc.indexed', store: 'vector', ...result })
    return result
  }

  async searchDocuments(
    query: string,
    maxResults: number
  ): Promise<{ query: string; resultCount: number; results: SearchResult[] }> {
    let queryEmbedding: number[]
    try {
      queryEmbedding = await this.embed(query)
    } catch (err) {
      throw new EmbedError(`Failed to embed search query`, err)
    }

    const scored = this.chunks
      .map(chunk => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)

    const results: SearchResult[] = scored.map(({ chunk, score }, i) => ({
      rank: i + 1,
      score: Number(score.toFixed(3)),
      title: chunk.title,
      url: chunk.url,
      excerpt:
        chunk.content.length > EXCERPT_LENGTH
          ? chunk.content.slice(0, EXCERPT_LENGTH) + '…'
          : chunk.content,
    }))

    logger.info({ event: 'search', store: 'vector', query, resultCount: results.length, topScore: results[0]?.score ?? 0 })
    return { query, resultCount: results.length, results }
  }

  async listDocuments() {
    return {
      totalDocuments: this.docCount,
      documents: Array.from(this.registry.entries()).map(([id, { title, url }]) => ({
        id,
        title,
        url,
      })),
    }
  }

  getDocCount(): number {
    return this.docCount
  }

  async clearDocuments(): Promise<void> {
    this.chunks.length = 0
    this.registry.clear()
    this.docCount = 0
    logger.info({ event: 'index.cleared', store: 'vector' })
  }
}

// ── Default local embedder (requires @huggingface/transformers) ───────────────

/**
 * Creates a local embedder using all-MiniLM-L6-v2 (~25 MB, downloads once).
 * Install: npm install @huggingface/transformers
 */
export async function createLocalEmbedder(): Promise<EmbedFn> {
  // Dynamic import so the package is optional — app still runs with other providers
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — install with: npm install @huggingface/transformers
  const { pipeline } = await import('@huggingface/transformers')
  const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')

  return async (text: string): Promise<number[]> => {
    const output = await pipe(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data as Float32Array)
  }
}
