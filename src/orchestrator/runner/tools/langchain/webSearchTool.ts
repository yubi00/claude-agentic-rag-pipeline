import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { D, R } from '../../../../libs/ansi.js'
import { tavilySearch, formatSearchResults } from '../../../../tools/webTools.js'
import type { IRagStore } from '../../../../rag/interface.js'

export function createWebSearchTool(
    color: string,
    usage: { searches: number; indexed: number },
    maxSearches: number,
    ragStore?: IRagStore,
    indexedUrls?: Set<string>
) {
    return new DynamicStructuredTool({
        name: 'WebSearch',
        description: 'Search the web for information relevant to the research task.',
        schema: z.object({ query: z.string().describe('The search query') }),
        func: async ({ query }) => {
            if (usage.searches >= maxSearches) return 'Search budget exhausted.'
            usage.searches++

            console.log(`  ${color}[researcher:WebSearch  ▶]${R} ${D}${query.slice(0, 140)}${R}`)
            const results = await tavilySearch(query)
            console.log(`  ${color}[researcher:WebSearch  ◀]${R} ${D}${results.length} URL(s) returned${R}`)
            console.log(`  ${D}[researcher] analysing results...${R}`)

            if (ragStore) {
                const indexable = results.filter(r =>
                    r.snippet.split(/\s+/).length >= 20 &&
                    !(indexedUrls?.has(r.url))
                )
                await Promise.all(
                    indexable.map(r => {
                        indexedUrls?.add(r.url)
                        return ragStore.addDocument({
                            url: r.url,
                            title: r.title,
                            content: `${r.title}\n\n${r.snippet}`,
                        })
                    })
                )
                usage.indexed += indexable.length
            }

            return formatSearchResults(results)
        },
    })
}
