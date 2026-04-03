import { tool } from '@anthropic-ai/claude-agent-sdk'
import type { IRagStore } from '../interface.js'
import { toMessage } from '../errors.js'
import { logger } from '../../libs/logger.js'

export function makeClearIndexTool(store: IRagStore) {
  return tool(
    'clear_index',
    'Remove all documents from the knowledge base and reset it to empty.',
    {},
    async () => {
      try {
        await store.clearDocuments()
        return {
          content: [{ type: 'text' as const, text: 'Knowledge base cleared. All documents removed.' }],
        }
      } catch (err) {
        logger.error({ event: 'tool.error', tool: 'clear_index', err: toMessage(err) })
        return {
          content: [{ type: 'text' as const, text: `Error clearing index: ${toMessage(err)}` }],
        }
      }
    }
  )
}
