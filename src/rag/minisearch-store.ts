/**
 * MiniSearchStore — BM25 full-text search backend.
 *
 * Implements IRagStore using MiniSearch (in-process, no subprocess).
 * Documents are split into chunks by the injected IChunker before indexing —
 * each chunk is a separate MiniSearch entry with the parent doc's metadata.
 */

import MiniSearch from 'minisearch'
import type { IRagStore, SearchResult, AddDocumentResult } from './interface.js'
import type { IChunker } from './chunker/index.js'
import { defaultChunker } from './chunker/index.js'
import { StoreError } from './errors.js'
import { logger } from '../libs/logger.js'

// ── Internal types ────────────────────────────────────────────────────────────

interface StoredChunk {
  id: string   // "{docId}-{chunkIndex}"
  docId: number
  title: string
  url: string
  content: string
}

interface SearchHit extends StoredChunk {
  score: number
  terms: string[]
  queryTerms: string[]
  match: Record<string, string[]>
}

const EXCERPT_LENGTH = 500

// ── Implementation ────────────────────────────────────────────────────────────

export class MiniSearchStore implements IRagStore {
  private docCount = 0

  private readonly index = new MiniSearch<StoredChunk>({
    idField: 'id',
    fields: ['title', 'content'],
    storeFields: ['docId', 'title', 'url', 'content'],
  })

  private readonly registry = new Map<number, { title: string; url: string }>()

  constructor(private readonly chunker: IChunker = defaultChunker) {}

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

    try {
      for (const chunk of chunks) {
        this.index.add({
          id: `${docId}-${chunk.index}`,
          docId,
          title,
          url,
          content: chunk.content,
        })
      }
    } catch (err) {
      this.registry.delete(docId)
      this.docCount--
      throw new StoreError(`Failed to index document "${title}"`, err)
    }

    const result = { id: docId, title, contentLength: params.content.length, chunkCount: chunks.length }
    logger.info({ event: 'doc.indexed', store: 'minisearch', ...result })
    return result
  }

  async searchDocuments(
    query: string,
    maxResults: number
  ): Promise<{ query: string; resultCount: number; results: SearchResult[] }> {
    let hits: SearchHit[]
    try {
      hits = this.index
        .search(query, { boost: { title: 2 }, fuzzy: 0.2 })
        .slice(0, maxResults) as SearchHit[]
    } catch (err) {
      throw new StoreError(`Search failed for query "${query}"`, err)
    }

    const results: SearchResult[] = hits.map((r, i) => ({
      rank: i + 1,
      score: Number(r.score.toFixed(3)),
      title: r.title,
      url: r.url,
      excerpt:
        r.content.length > EXCERPT_LENGTH
          ? r.content.slice(0, EXCERPT_LENGTH) + '…'
          : r.content,
    }))

    logger.info({ event: 'search', store: 'minisearch', query, resultCount: hits.length, topScore: results[0]?.score ?? 0 })
    return { query, resultCount: hits.length, results }
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
    try {
      this.index.removeAll()
    } catch (err) {
      throw new StoreError('Failed to clear index', err)
    }
    this.registry.clear()
    this.docCount = 0
    logger.info({ event: 'index.cleared', store: 'minisearch' })
  }
}
