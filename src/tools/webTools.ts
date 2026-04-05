import { TAVILY_API_KEY } from '../config/env.js'

/**
 * Core web tool implementations — no SDK dependencies.
 *
 * These functions contain the actual HTTP logic for web search and page fetching.
 * They are SDK-agnostic and can be wrapped by any agent framework:
 * Vercel AI SDK, LangChain, plain function calls, etc.
 */

export interface SearchResult {
    url: string
    title: string
    snippet: string
}

export interface FetchResult {
    url: string
    title: string
    text: string
}

/**
 * Search the web using the Tavily API.
 * Requires TAVILY_API_KEY in environment.
 */
export async function tavilySearch(query: string, maxResults = 5): Promise<SearchResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: maxResults }),
    })

    const data = await res.json() as { results: Array<{ url: string; title: string; content: string }> }
    return (data.results ?? []).map(r => ({ url: r.url, title: r.title, snippet: r.content }))
}

/**
 * Fetch a web page via Jina Reader (https://r.jina.ai).
 * Jina renders JS-heavy pages server-side and returns clean markdown.
 * Returns null if the page has no readable content.
 */
export async function jinaFetch(url: string, maxChars = 12_000): Promise<FetchResult | null> {
    const res = await fetch(`https://r.jina.ai/${url}`, {
        headers: {
            'Accept': 'text/plain',
            'X-Timeout': '15',
        },
        signal: AbortSignal.timeout(20_000),
    })

    const text = (await res.text()).slice(0, maxChars)
    if (text.length < 100) return null

    const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? url
    return { url, title, text }
}

/**
 * Format Tavily search results as a plain text string for model consumption.
 */
export function formatSearchResults(results: SearchResult[]): string {
    return results.map(r => `URL: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`).join('\n\n')
}
