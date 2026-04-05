/**
 * RAG runtime bootstrap.
 *
 * Creates the active store and MCP server explicitly at startup instead of
 * doing expensive async work at module import time.
 *
 * ─── Option A: BM25 / MiniSearch (default, zero deps, in-process) ────────────
 *
 *   const store = new MiniSearchStore()
 *   return { ragStore: store, ragServer: createRagServer(store) }
 *
 * ─── Option B: Vector / in-memory (no DB, local embeddings) ──────────────────
 *
 *   import { VectorStore, createLocalEmbedder } from './vector-store.js'
 *   const store = new VectorStore(await createLocalEmbedder())
 *   return { ragStore: store, ragServer: createRagServer(store) }
 *
 * ─── Option C: Neon pgvector (production, persistent) ── ACTIVE ──────────────
 *
 *   Requires: DATABASE_URL in .env
 *   Embedding dimension must match the embed function (384 for all-MiniLM-L6-v2)
 */

import { NeonVectorStore } from './neon-store.js'
import type { IRagStore } from './interface.js'
import { createLocalEmbedder } from './vector-store.js'
import { createRagServer } from './server.js'
import { InitError } from './errors.js'
import { DATABASE_URL } from '../config/env.js'

export interface RagRuntime {
  ragStore: IRagStore
  ragServer: ReturnType<typeof createRagServer>
}

export async function initializeRagRuntime(): Promise<RagRuntime> {
  const embedFn = await createLocalEmbedder()
  const store = new NeonVectorStore(DATABASE_URL!, embedFn)
  await store.initialize()

  return {
    ragStore: store,
    ragServer: createRagServer(store),
  }
}
