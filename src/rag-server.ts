/**
 * In-process RAG MCP server using MiniSearch (BM25-based full-text search).
 *
 * Exposes 4 tools:
 *   index_document   – add a document to the knowledge base
 *   search_documents – BM25 search, returns ranked passages
 *   list_indexed     – show what's currently in the knowledge base
 *   clear_index      – reset (useful between questions)
 *
 * The server runs in the same Node.js process as the orchestrator.
 * No subprocess, no IPC – MiniSearch is a plain JS object in memory.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import MiniSearch from 'minisearch'
import { z } from 'zod'

// ── Internal state ──────────────────────────────────────────────────────────

interface StoredDoc {
  id: number
  title: string
  url: string
  content: string
}

interface SearchResult extends StoredDoc {
  score: number
  terms: string[]
  queryTerms: string[]
  match: Record<string, string[]>
}

const EXCERPT_LENGTH = 400

let docCount = 0

// MiniSearch index: BM25 scoring over title + content fields
const miniSearch = new MiniSearch<StoredDoc>({
  fields: ['title', 'content'],
  storeFields: ['title', 'url', 'content'],
})

// Separate metadata map so we can list docs without searching
const docRegistry = new Map<number, { title: string; url: string }>()

// ── Tool: index_document ────────────────────────────────────────────────────

const indexDocumentTool = tool(
  'index_document',
  'Add a document to the RAG knowledge base. Content is indexed for BM25 full-text search.',
  {
    content: z.string().describe('Full text content to index'),
    url: z.string().optional().describe('Source URL of the document'),
    title: z.string().optional().describe('Title of the document'),
    relevance_note: z.string().optional().describe('Why this document is relevant to the query'),
  },
  async ({ content, url, title, relevance_note }) => {
    const id = ++docCount
    const docTitle = title ?? `Document ${id}`
    const docUrl = url ?? ''

    miniSearch.add({ id, title: docTitle, url: docUrl, content })
    docRegistry.set(id, { title: docTitle, url: docUrl })

    const result = {
      success: true,
      documentId: id,
      title: docTitle,
      contentLength: content.length,
      message: `Indexed "${docTitle}" (${content.length} chars) as document #${id}`,
      ...(relevance_note ? { relevanceNote: relevance_note } : {}),
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }
  }
)

// ── Tool: search_documents ──────────────────────────────────────────────────

const searchDocumentsTool = tool(
  'search_documents',
  'BM25 full-text search over indexed documents. Returns ranked passages with scores and source URLs.',
  {
    query: z.string().describe('Search query — use natural language or key terms'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Number of results to return (default 5)'),
  },
  async ({ query, max_results }) => {
    if (docCount === 0) {
      return {
        content: [{ type: 'text' as const, text: 'Knowledge base is empty. Index documents first.' }],
      }
    }

    const results = miniSearch.search(query, { boost: { title: 2 }, fuzzy: 0.2 }).slice(0, max_results) as SearchResult[]

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No results found for: "${query}"\nKnowledge base has ${docCount} document(s). Try different terms.`,
          },
        ],
      }
    }

    const formatted = results.map((r, i) => ({
      rank: i + 1,
      score: Number(r.score.toFixed(3)),
      title: r.title,
      url: r.url,
      excerpt: r.content.length > EXCERPT_LENGTH ? r.content.slice(0, EXCERPT_LENGTH) + '…' : r.content,
    }))

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ query, resultCount: results.length, results: formatted }, null, 2),
        },
      ],
    }
  }
)

// ── Tool: list_indexed ──────────────────────────────────────────────────────

const listIndexedTool = tool(
  'list_indexed',
  'List all documents currently in the RAG knowledge base with their titles and URLs.',
  {},
  async () => {
    if (docCount === 0) {
      return {
        content: [{ type: 'text' as const, text: 'Knowledge base is empty.' }],
      }
    }

    const documents = Array.from(docRegistry.entries()).map(([id, meta]) => ({
      id,
      title: meta.title,
      url: meta.url,
    }))

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ totalDocuments: docCount, documents }, null, 2),
        },
      ],
    }
  }
)

// ── Tool: clear_index ───────────────────────────────────────────────────────

const clearIndexTool = tool(
  'clear_index',
  'Remove all documents from the knowledge base and reset it to empty.',
  {},
  async () => {
    miniSearch.removeAll()
    docRegistry.clear()
    docCount = 0

    return {
      content: [{ type: 'text' as const, text: 'Knowledge base cleared. All documents removed.' }],
    }
  }
)

// ── Export the MCP server singleton ────────────────────────────────────────

export const ragServer = createSdkMcpServer({
  name: 'rag',
  version: '1.0.0',
  tools: [indexDocumentTool, searchDocumentsTool, listIndexedTool, clearIndexTool],
})
