/**
 * RAG error hierarchy.
 *
 * RagError        — base class, catch this to handle any RAG failure
 *   StoreError    — index/search/DB operation failed
 *   EmbedError    — embedding function failed (network, model, timeout)
 *   InitError     — store failed to initialise (bad connection string, missing extension)
 */

export class RagError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'RagError'
  }
}

export class StoreError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, cause)
    this.name = 'StoreError'
  }
}

export class EmbedError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, cause)
    this.name = 'EmbedError'
  }
}

export class InitError extends RagError {
  constructor(message: string, cause?: unknown) {
    super(message, cause)
    this.name = 'InitError'
  }
}

/** Extracts a readable message from an unknown thrown value. */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Unknown error'
}
