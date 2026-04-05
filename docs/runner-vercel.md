# Runner: Vercel AI SDK + Gemini

Implementation: `src/orchestrator/runner/vercelAgentRunner.ts`

Set `AGENT_PROVIDER=vercel` to use this runner.

---

## How it works

```text
vercelAgentRunner.run(agent, prompt, runtime, budget)
  |
  v
buildResearcherTools(color, budget, ragStore)   ← researcher only
  or
buildSynthesizerTools(agent, runtime)           ← synthesizer only
  |
  v
new ToolLoopAgent({
  model: google(GEMINI_MODEL),
  instructions: systemPrompt,
  tools,
  stopWhen: [stepCountIs(maxSteps), isBudgetExhausted],
})
  |
  v
agentInstance.generate({ prompt })
  → loops: model calls tool(s) → tools execute → results fed back → model decides
  → stops when stepCount or isBudgetExhausted condition is met
  |
  v
AgentRunResult { text, turns, costUsd, durationMs, failedUrls, indexedCount }
```

---

## Architectural decisions

### 1. `ToolLoopAgent` over `generateText`

**Problem**: `generateText` with tools requires the caller to manually detect tool calls, execute them, feed results back, and loop. This is boilerplate that needs to be correct and is easy to get wrong (error handling, turn limits, streaming).

**Decision**: Use `ToolLoopAgent`, which is purpose-built for agentic loops. It manages the tool call → result → continue cycle automatically.

**Tradeoff**: `ToolLoopAgent` is higher-level — less control over individual turns. Acceptable because the orchestrator controls iteration at a higher level.

---

### 2. Custom tools (Tavily + Jina) over native SDK tools

**Problem**: The Vercel AI SDK doesn't provide built-in web search or page fetch tools. Even if it did, we'd have no control over budgeting, content indexing, or error handling.

**Decision**: Build custom tools around two specialized services:
- **Tavily** — search API optimised for LLM use, returns clean snippets (no HTML parsing)
- **Jina Reader** (`https://r.jina.ai/<url>`) — server-side JS rendering, returns clean markdown

**SDK-agnostic core**: The actual HTTP logic lives in `src/tools/webTools.ts` — no Vercel imports. Langchain and future runners import the same functions.

**Tradeoff**: Additional external API dependencies (Tavily API key, Jina public endpoint). Jina has a rate limit on the free tier.

---

### 3. Direct RAG indexing inside tools (not post-run extraction)

**Problem**: Original design had the researcher model produce `<<<SOURCE>>>` blocks containing fetched content, which the orchestrator would parse and index. This failed because:
- The model compressed or rewrote content during extraction (losing factual detail)
- Large pages caused the model to summarize rather than preserve verbatim text
- The model sometimes forgot to emit SOURCE blocks at all

**Decision**: Index content directly inside the tool `execute` function — immediately after `jinaFetch()` returns. The model never sees or touches the raw content.

```typescript
// WebFetch tool execute function
const result = await jinaFetch(url)
if (ragStore) {
    await ragStore.addDocument({ url: result.url, title: result.title, content: result.text })
    usage.indexed++
}
return `Fetched and indexed: ${url}`   ← model only sees this confirmation
```

**Result**: Verbatim content preserved. `indexedCount` on `AgentRunResult` tells the orchestrator how many documents were indexed — no need to parse SOURCE blocks for this.

---

### 4. `<<<SOURCE>>>` delimiters for deduplication markers

**Problem**: Original SOURCE blocks used `---` as delimiters. Jina Reader returns pages as markdown, which also uses `---` for horizontal rules and front-matter separators. The orchestrator's regex parser was splitting inside page content.

**Decision**: Switch to `<<<SOURCE>>>` / `<<<END>>>` — characters that will never appear naturally in markdown or HTML content.

```
<<<SOURCE>>>
SOURCE: https://example.com/trail
TITLE: Best Hiking Trails Melbourne
<<<END>>>
```

**Note**: SOURCE blocks now only serve deduplication — content indexing already happened in the tool. The orchestrator uses `indexedCount` (from `usage.indexed`) rather than counting SOURCE blocks to decide whether to run the synthesizer.

---

### 5. Mutex for parallel `search_documents` calls

**Problem**: Gemini (unlike Claude) calls multiple tools in parallel when the synthesizer decides to search several angles simultaneously. Our RAG store handles concurrent reads, but the synthesizer's ReAct reasoning depends on observing one result before deciding the next query. Parallel execution breaks the observe-then-decide loop.

**Decision**: Serialize calls using a promise-chain mutex — a zero-dependency pattern that queues async work without a lock primitive.

```typescript
let searchQueue = Promise.resolve()    // starts as already-resolved

execute: ({ query }) => {
    const result = searchQueue.then(async () => {
        return await ragStore.searchDocuments(query)
    })
    searchQueue = result.then(() => {}, () => {})   // advance queue on success OR error
    return result
}
```

Each call chains onto the current tail of the queue. The `.then(() => {}, () => {})` ensures a failed search doesn't block all future searches.

**Why not needed for LangChain**: LangChain's ReAct loop is strictly sequential by design (one tool per step). The mutex is Vercel-specific.

---

### 6. Hard budget stop via `stopWhen`

**Problem**: Relying on the model to stop calling tools when told "budget exhausted" is unreliable. The model may continue anyway, especially across multiple tool calls.

**Decision**: Use Vercel's `stopWhen` to enforce a hard framework-level stop — the agent loop exits before the model can make another tool call.

```typescript
const isBudgetExhausted = (_opts: { steps: unknown[] }) =>
    usage.searches >= maxSearches && usage.fetches >= maxFetches

stopWhen: [stepCountIs(maxSteps), isBudgetExhausted]
```

**Why both conditions**: Stopping when only searches OR only fetches are exhausted would be wrong — the researcher can still fetch after using all searches, or vice versa.

---

### 7. Snippet indexing in WebSearch

**Problem**: Some queries are factual enough that search snippets contain the answer. Without indexing snippets, the synthesizer would find empty RAG results if the researcher only searched and never fetched.

**Decision**: Index search snippets directly alongside full pages. Filter by a minimum word count (20 words) to skip useless one-line snippets.

**Deduplication**: A shared `indexedUrls: Set<string>` is passed to both WebSearch and WebFetch. Before indexing, each tool checks this set and skips already-indexed URLs. This prevents re-indexing a URL that appeared in multiple search queries.

---

## Tool file structure

```
src/
├── tools/
│   └── webTools.ts                        ← SDK-agnostic: tavilySearch, jinaFetch, formatSearchResults
└── orchestrator/runner/
    ├── vercelAgentRunner.ts               ← runner entry point
    ├── vercelTools.ts                     ← wiring only: assembles tool sets from factories
    └── tools/
        ├── webSearchTool.ts               ← Vercel tool() wrapper for WebSearch
        ├── webFetchTool.ts                ← Vercel tool() wrapper for WebFetch
        └── searchDocumentsTool.ts         ← Vercel tool() wrapper for search_documents (with mutex)
```

---

## Content flow

```text
researcher
  ↓ WebSearch  → tavilySearch() → snippets indexed if ≥20 words (via ragStore)
  ↓ WebFetch   → jinaFetch()   → full markdown page indexed (via ragStore)
  ↓ model emits <<<SOURCE>>> markers (URL + Title only) for dedup tracking

orchestrator
  ↓ parses <<<SOURCE>>> markers → deduplicates against previouslyCovered
  ↓ sourceCount = researcher.indexedCount (not SOURCE marker count)
  ↓ if sourceCount == 0 → skip synthesizer, retry

synthesizer
  ↓ search_documents (direct ragStore call, serialised via mutex)
  ↓ composes cited answer + JSON confidence block
```

---

## Cost profile

| Component | Model | Typical cost/run |
|-----------|-------|-----------------|
| Researcher | gemini-2.5-flash | ~$0.001–0.005 |
| Synthesizer | gemini-2.5-flash | ~$0.001–0.005 |
| Total | | ~$0.003–0.015 |

Gemini 2.5 Flash pricing: $0.10/1M input tokens, $0.40/1M output tokens.
~10–25x cheaper than the Claude runner for equivalent complexity.

---

## Key env vars

```
AGENT_PROVIDER=vercel
GOOGLE_GENERATIVE_AI_API_KEY=...
TAVILY_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

---

## Known limitations

| Issue | Status |
|-------|--------|
| Gemini parallelises tool calls by default | Fixed via mutex in synthesizer |
| JS-heavy pages (AllTrails, TripAdvisor) | Mostly fixed by Jina; some return thin content |
| Budget stop only fires when BOTH search AND fetch exhausted | By design |
| Jina public endpoint has no auth | Acceptable for dev; add `X-Api-Key` header for prod |

---

## Tradeoffs vs other runners

| | Vercel | Claude | LangChain |
|---|---|---|---|
| Tool execution | Parallel | Parallel | Sequential (ReAct) |
| Hard budget stop | `stopWhen` (framework) | `max_turns` | `recursionLimit` only |
| Parallel tool mutex | Needed + implemented | Not needed | Not needed |
| Content extraction | Code (Jina, in tool) | Model | Code (Jina, in tool) |
| JS-heavy pages | Jina handles | SDK-dependent | Jina handles |
| Cost/run | ~$0.003–0.015 | ~$0.10–0.19 | ~$0.003–0.015 |
| Model flexibility | Any via Vercel SDK | Claude only | Any via LangChain |
