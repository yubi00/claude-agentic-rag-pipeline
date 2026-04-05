/**
 * Structured logger — Pino singleton used across the whole app.
 *
 * Dev  (NODE_ENV !== 'production'): pretty-printed, human-readable
 * Prod (NODE_ENV === 'production'): newline-delimited JSON → pipe to Datadog, Logtail, etc.
 *
 * Usage:
 *   import { logger } from '../libs/logger.js'
 *   logger.info({ event: 'doc.indexed', docId: 1, chunks: 4 })
 *   logger.error({ event: 'embed.failed', err: toMessage(err) })
 */

import pino from 'pino'
import { LOG_LEVEL, NODE_ENV } from '../config/env.js'

const isProd = NODE_ENV === 'production'

export const logger = pino(
  {
    level: LOG_LEVEL,
    base: { service: 'claude-agentinc-rag' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  isProd
    ? undefined                          // stdout JSON in prod
    : pino.transport({                   // pretty-print in dev
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname,service',
          translateTime: 'HH:MM:ss',
        },
      })
)
