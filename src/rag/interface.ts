/**
 * IRagStore — the common contract every RAG backend must satisfy.
 *
 * Swap implementations in rag/index.ts without touching anything else.
 * Open for extension (new stores), closed for modification (shared interface).
 */

export interface SearchResult {
  rank: number
  score: number
  title: string
  url: string
  excerpt: string
}

export interface AddDocumentResult {
  id: number
  title: string
  contentLength: number
  chunkCount: number
}

export interface IRagStore {
  addDocument(params: {
    title?: string
    url?: string
    content: string
  }): Promise<AddDocumentResult>

  searchDocuments(
    query: string,
    maxResults: number
  ): Promise<{ query: string; resultCount: number; results: SearchResult[] }>

  listDocuments(): Promise<{
    totalDocuments: number
    documents: Array<{ id: number; title: string; url: string }>
  }>

  getDocCount(): number

  clearDocuments(): Promise<void>
}
