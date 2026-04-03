import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { IRagStore } from '../interface.js'
import { toMessage } from '../errors.js'
import { logger } from '../../libs/logger.js'

export function makeIndexDocumentTool(store: IRagStore) {
  return tool(
    'index_document',
    'Add a document to the RAG knowledge base. Content is indexed for full-text search.',
    {
      content:        z.string().describe('Full text content to index'),
      url:            z.string().optional().describe('Source URL of the document'),
      title:          z.string().optional().describe('Title of the document'),
      relevance_note: z.string().optional().describe('Why this document is relevant to the query'),
    },
    async ({ content, url, title, relevance_note }) => {
      try {
        const doc = await store.addDocument({ title, url, content })

        const result = {
          success: true,
          documentId: doc.id,
          title: doc.title,
          contentLength: doc.contentLength,
          chunkCount: doc.chunkCount,
          message: `Indexed "${doc.title}" (${doc.contentLength} chars, ${doc.chunkCount} chunk(s)) as document #${doc.id}`,
          ...(relevance_note ? { relevanceNote: relevance_note } : {}),
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        logger.error({ event: 'tool.error', tool: 'index_document', err: toMessage(err) })
        return {
          content: [{ type: 'text' as const, text: `Error indexing document: ${toMessage(err)}` }],
        }
      }
    }
  )
}
