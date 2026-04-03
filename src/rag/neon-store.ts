/**
 * NeonVectorStore — pgvector-backed semantic search via Neon serverless Postgres.
 *
 * Documents are split into chunks by the injected IChunker — each chunk is a
 * separate row in Postgres with its own embedding, enabling fine-grained retrieval.
 *
 * Setup:
 *   1. Create a project at neon.tech
 *   2. Run in the SQL Editor: CREATE EXTENSION IF NOT EXISTS vector;
 *   3. Set DATABASE_URL in .env
 *   4. npm install @neondatabase/serverless
 *
 * Then in rag/index.ts:
 *   import { NeonVectorStore } from './neon-store.js'
 *   import { createLocalEmbedder } from './vector-store.js'
 *   const store = new NeonVectorStore(process.env.DATABASE_URL!, await createLocalEmbedder())
 *   await store.initialize()
 *   export const ragServer = createRagServer(store)
 *
 * Embedding dimension must match your embed function:
 *   384  → all-MiniLM-L6-v2 (local, @huggingface/transformers)
 *   1536 → text-embedding-3-small (OpenAI)
 *   3072 → text-embedding-3-large (OpenAI)
 */

// @ts-ignore — install with: npm install @neondatabase/serverless
import { neon } from '@neondatabase/serverless'
import type { IRagStore, SearchResult, AddDocumentResult } from './interface.js'
import type { EmbedFn } from './vector-store.js'
import type { IChunker } from './chunker/index.js'
import { defaultChunker } from './chunker/index.js'
import { EmbedError, InitError, StoreError } from './errors.js'
import { logger } from '../libs/logger.js'

// ── Local types for neon since the package may not be installed ───────────────

/** Minimal type for the tagged-template SQL client returned by neon(). */
type NeonSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<NeonRow[]>) & {
  // `neon()` exposes an `unsafe` helper for injecting raw SQL fragments.
  unsafe: (raw: string) => unknown
}
type NeonRow = Record<string, unknown>

// Typed row shapes for each query — no `any` needed at usage sites
interface CountRow { count: number }
interface SearchRow { title: string; url: string; content: string; score: number }
interface ListRow { id: number; title: string; url: string }

// ─────────────────────────────────────────────────────────────────────────────

const EXCERPT_LENGTH = 500

export class NeonVectorStore implements IRagStore {
  private readonly sql: NeonSql
  private cachedDocCount = 0

  constructor(
    connectionString: string,
    private readonly embed: EmbedFn,
    private readonly dimension = 384,
    private readonly chunker: IChunker = defaultChunker
  ) {
    this.sql = neon(connectionString) as NeonSql
  }

  /**
   * Creates the table and index if they don't exist.
   * Call once before registering the MCP server.
   */
  async initialize(): Promise<void> {
    try {
      await this.sql`CREATE EXTENSION IF NOT EXISTS vector`

      await this.sql`
        CREATE TABLE IF NOT EXISTS rag_chunks (
          id          SERIAL  PRIMARY KEY,
          doc_id      INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          title       TEXT    NOT NULL,
          url         TEXT    NOT NULL DEFAULT '',
          content     TEXT    NOT NULL,
          embedding   vector(${this.sql.unsafe(String(this.dimension))})
        )
      `

      // IVFFlat index for approximate nearest-neighbour search at scale.
      // Safe to run repeatedly — ignored if already exists.
      await this.sql`
        CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
          ON rag_chunks
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100)
      `

      const [row] = (await this.sql`SELECT COUNT(DISTINCT doc_id)::int AS count FROM rag_chunks`) as unknown as CountRow[]
      this.cachedDocCount = row.count ?? 0
    } catch (err) {
      throw new InitError('Failed to initialise Neon vector store — check DATABASE_URL and that the pgvector extension is enabled', err)
    }
    logger.info({ event: 'store.init', store: 'neon', existingDocs: this.cachedDocCount, dimension: this.dimension })
  }

  async addDocument(params: {
    title?: string
    url?: string
    content: string
  }): Promise<AddDocumentResult> {
    const docId = ++this.cachedDocCount
    const title = params.title ?? `Document ${docId}`
    const url = params.url ?? ''

    const chunks = this.chunker.chunk(params.content)

    try {
      await Promise.all(
        chunks.map(async chunk => {
          let embedding: number[]
          try {
            embedding = await this.embed(`${title}\n\n${chunk.content}`)
          } catch (err) {
            throw new EmbedError(`Failed to embed chunk ${chunk.index} of "${title}"`, err)
          }

          const vectorLiteral = `[${embedding.join(',')}]`
          await this.sql`
            INSERT INTO rag_chunks (doc_id, chunk_index, title, url, content, embedding)
            VALUES (
              ${docId},
              ${chunk.index},
              ${title},
              ${url},
              ${chunk.content},
              ${vectorLiteral}::vector
            )
          `
        })
      )
    } catch (err) {
      this.cachedDocCount--
      if (err instanceof EmbedError) throw err
      throw new StoreError(`Failed to insert chunks for document "${title}"`, err)
    }

    const result = { id: docId, title, contentLength: params.content.length, chunkCount: chunks.length }
    logger.info({ event: 'doc.indexed', store: 'neon', ...result })
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
      throw new EmbedError('Failed to embed search query', err)
    }

    const vectorLiteral = `[${queryEmbedding.join(',')}]`

    // <=> is cosine distance (0 = identical, 2 = opposite).
    // Score returned is cosine similarity: 1 - distance.
    const rows = (await this.sql`
      SELECT
        title,
        url,
        content,
        1 - (embedding <=> ${vectorLiteral}::vector) AS score
      FROM rag_chunks
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${maxResults}
    `) as unknown as SearchRow[]

    const results: SearchResult[] = rows.map((row, i) => ({
      rank: i + 1,
      score: Number(Number(row.score).toFixed(3)),
      title: row.title,
      url: row.url,
      excerpt:
        row.content.length > EXCERPT_LENGTH
          ? row.content.slice(0, EXCERPT_LENGTH) + '…'
          : row.content,
    }))

    logger.info({ event: 'search', store: 'neon', query, resultCount: results.length, topScore: results[0]?.score ?? 0 })
    return { query, resultCount: results.length, results }
  }

  async listDocuments(): Promise<{
    totalDocuments: number
    documents: Array<{ id: number; title: string; url: string }>
  }> {
    const rows = (await this.sql`
      SELECT DISTINCT ON (doc_id) doc_id AS id, title, url
      FROM rag_chunks
      ORDER BY doc_id
    `) as unknown as ListRow[]

    return {
      totalDocuments: this.cachedDocCount,
      documents: rows.map(row => ({
        id: Number(row.id),
        title: row.title,
        url: row.url,
      })),
    }
  }

  getDocCount(): number {
    return this.cachedDocCount
  }

  async clearDocuments(): Promise<void> {
    try {
      await this.sql`TRUNCATE TABLE rag_chunks RESTART IDENTITY`
    } catch (err) {
      throw new StoreError('Failed to clear Neon vector store', err)
    }
    this.cachedDocCount = 0
    logger.info({ event: 'index.cleared', store: 'neon' })
  }
}
