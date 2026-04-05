import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { D, R } from '../../../../libs/ansi.js'
import { jinaFetch } from '../../../../tools/webTools.js'
import type { IRagStore } from '../../../../rag/interface.js'

export function createWebFetchTool(
    color: string,
    usage: { fetches: number; indexed: number },
    maxFetches: number,
    failedUrls: Set<string>,
    ragStore?: IRagStore,
    indexedUrls?: Set<string>
) {
    return new DynamicStructuredTool({
        name: 'WebFetch',
        description: 'Fetch the full text content of a web page.',
        schema: z.object({ url: z.string().describe('The URL to fetch') }),
        func: async ({ url }) => {
            if (usage.fetches >= maxFetches) return 'Fetch budget exhausted.'
            usage.fetches++

            console.log(`  ${color}[researcher:WebFetch   ▶]${R} ${D}${url.slice(0, 160)}${R}`)
            console.log(`  ${D}[researcher] fetching via Jina Reader...${R}`)

            try {
                const result = await jinaFetch(url)

                if (!result) {
                    failedUrls.add(url)
                    return 'Page returned no readable content.'
                }

                console.log(`  ${color}[researcher:WebFetch   ◀]${R} ${D}${result.text.length} chars fetched${R}`)
                console.log(`  ${D}[researcher] analysing results...${R}`)

                if (ragStore && !indexedUrls?.has(result.url)) {
                    indexedUrls?.add(result.url)
                    await ragStore.addDocument({ url: result.url, title: result.title, content: result.text })
                    console.log(`  ${D}[researcher:WebFetch] indexed: ${result.title.slice(0, 80)}${R}`)
                    usage.indexed++
                }

                return `Fetched and indexed: ${url}`
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                console.log(`  ${color}[researcher:WebFetch   ◀]${R} ${D}failed: ${msg}${R}`)
                failedUrls.add(url)
                return `Failed to fetch ${url}: ${msg}`
            }
        },
    })
}
