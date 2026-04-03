import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { IRagStore } from '../interface.js'
import { toMessage } from '../errors.js'
import { logger } from '../../libs/logger.js'

export function makeListIndexedTool(store: IRagStore) {
  return tool(
    'list_indexed',
    'List all documents currently in the RAG knowledge base with their titles and URLs.',
    {},
    async () => {
      try {
        if (store.getDocCount() === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Knowledge base is empty.' }],
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(await store.listDocuments(), null, 2),
            },
          ],
        }
      } catch (err) {
        logger.error({ event: 'tool.error', tool: 'list_indexed', err: toMessage(err) })
        return {
          content: [{ type: 'text' as const, text: `Error listing documents: ${toMessage(err)}` }],
        }
      }
    }
  )
}
