import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { IRagStore } from '../interface.js'
import { toMessage } from '../errors.js'
import { logger } from '../../libs/logger.js'

export function makeSearchDocumentsTool(store: IRagStore) {
  return tool(
    'search_documents',
    'Search indexed documents. Returns ranked passages with scores and source URLs.',
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
      try {
        if (store.getDocCount() === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Knowledge base is empty. Index documents first.' }],
          }
        }

        const { query: q, resultCount, results } = await store.searchDocuments(query, max_results)

        if (resultCount === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No results found for: "${q}"\nKnowledge base has ${store.getDocCount()} document(s). Try different terms.`,
              },
            ],
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ query: q, resultCount, results }, null, 2),
            },
          ],
        }
      } catch (err) {
        logger.error({ event: 'tool.error', tool: 'search_documents', query, err: toMessage(err) })
        return {
          content: [{ type: 'text' as const, text: `Error searching documents: ${toMessage(err)}` }],
        }
      }
    }
  )
}
