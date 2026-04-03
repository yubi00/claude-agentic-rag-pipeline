/**
 * Active RAG store configuration — swap backend here, nothing else changes.
 *
 * ─── Option A: BM25 / MiniSearch (default, zero deps, in-process) ────────────
 *
 *   export const ragServer = createRagServer(new MiniSearchStore())
 *
 * ─── Option B: Vector / in-memory (no DB, local embeddings) ──────────────────
 *
 *   import { VectorStore, createLocalEmbedder } from './vector-store.js'
 *   const store = new VectorStore(await createLocalEmbedder())
 *   export const ragServer = createRagServer(store)
 *
 * ─── Option C: Neon pgvector (production, persistent) ── ACTIVE ──────────────
 *
 *   Requires: DATABASE_URL in .env
 *   Embedding dimension must match the embed function (384 for all-MiniLM-L6-v2)
 */

import { NeonVectorStore } from './neon-store.js'
import { createLocalEmbedder } from './vector-store.js'
import { createRagServer } from './server.js'
import { InitError } from './errors.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new InitError('DATABASE_URL environment variable is not set')
}

const embedFn = await createLocalEmbedder()
const store = new NeonVectorStore(connectionString, embedFn)
await store.initialize()

export const ragServer = createRagServer(store)
