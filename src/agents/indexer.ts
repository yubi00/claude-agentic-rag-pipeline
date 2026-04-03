/**
 * Indexer agent — parses researcher output and adds documents to the RAG store.
 *
 * Receives the full researcher output (SOURCE blocks), calls index_document
 * for each, then calls list_indexed to confirm the knowledge base state.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

const INDEXER_PROMPT = `You are a document indexer. You receive research output containing SOURCE blocks and add each document to the RAG knowledge base.

## Your process

For EACH SOURCE block you receive:
1. Call index_document with:
   - content: the text from the CONTENT section
   - url: the URL from the SOURCE line
   - title: the title from the TITLE line
   - relevance_note: the text from the RELEVANCE line

2. Confirm the indexing result for each document

After indexing ALL documents:
3. Call list_indexed to confirm the current knowledge base state

## Output format

INDEXED: N documents
TITLES:
  - [title 1]
  - [title 2]
KNOWLEDGE BASE TOTAL: X documents (from list_indexed)`

export const indexerDef: AgentDefinition = {
  description:
    'Indexes research content into the RAG knowledge base. Pass the full researcher output (SOURCE blocks). Calls index_document for each source, then confirms with list_indexed.',
  prompt: INDEXER_PROMPT,
  model: 'haiku',
  mcpServers: ['rag'],
}
