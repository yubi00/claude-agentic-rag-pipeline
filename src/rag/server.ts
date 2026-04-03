/**
 * RAG MCP server factory.
 *
 * Creates an in-process MCP server backed by any IRagStore implementation.
 * Tools live in ./tools/ — add new tools there, register them here.
 *
 * Usage:
 *   const server = createRagServer(new MiniSearchStore())
 *   const server = createRagServer(new VectorStore(embedFn))
 *   const server = createRagServer(new NeonVectorStore(url, embedFn))
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { IRagStore } from './interface.js'
import {
  makeIndexDocumentTool,
  makeSearchDocumentsTool,
  makeListIndexedTool,
  makeClearIndexTool,
} from './tools/index.js'

export function createRagServer(store: IRagStore) {
  return createSdkMcpServer({
    name: 'rag',
    version: '1.0.0',
    tools: [
      makeIndexDocumentTool(store),
      makeSearchDocumentsTool(store),
      makeListIndexedTool(store),
      makeClearIndexTool(store),
    ],
  })
}
