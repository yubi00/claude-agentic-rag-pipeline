# Runner: Vercel AI SDK + Gemini

Implementation: `src/orchestrator/runner/vercelAgentRunner.ts`

Set `AGENT_PROVIDER=vercel` to use this runner.

---

## How it works

The Vercel runner uses `ToolLoopAgent` from the Vercel AI SDK (`ai` package). Unlike `generateText`, `ToolLoopAgent` is purpose-built for agentic loops — it manages the tool call / result / continue cycle automatically.

```text
vercelAgentRunner.run(agent, prompt, runtime)
  |
  v
buildResearcherTools(color, budget, ragStore)   ← researcher only
  or
buildSynthesizerTools(agent, color, runtime)    ← synthesizer only
  |
  v
new ToolLoopAgent({
  model: google(GEMINI_MODEL),
  instructions: system prompt,
  tools,
  stopWhen: [stepCountIs(maxSteps), budgetStop],
})
  |
  v
agentInstance.generate({ prompt })
  - loops: model calls tool → tool executes → result fed back → model decides
  - stops when stepCount or budgetStop condition is met
  |
  v
returns AgentRunResult { text, turns, costUsd, durationMs, failedUrls, indexedCount }
```

---

## Tools

### Tool file structure

```
src/
├── tools/
│   └── webTools.ts                        ← SDK-agnostic: tavilySearch, jinaFetch, formatSearchResults
└── orchestrator/runner/
    ├── vercelTools.ts                     ← wiring only: builds tool sets from factories
    └── tools/
        ├── webSearchTool.ts               ← Vercel tool wrapper for WebSearch
        ├── webFetchTool.ts                ← Vercel tool wrapper for WebFetch
        └── searchDocumentsTool.ts         ← Vercel tool wrapper for search_documents
```

`src/tools/webTools.ts` is SDK-agnostic — importable by any future runner (LangChain, etc).

### Researcher tools

All tools are custom — no platform-native equivalents available.

**WebSearch** (`src/orchestrator/runner/tools/webSearchTool.ts`)
- Calls `tavilySearch()` from `src/tools/webTools.ts`
- Returns up to 5 results: URL, title, snippet
- **Indexes snippets directly into RAG store** for factual queries that don't need full page fetch
- Budget-tracked via shared `usage.searches` counter
- Requires `TAVILY_API_KEY`

**WebFetch** (`src/orchestrator/runner/tools/webFetchTool.ts`)
- Calls `jinaFetch()` from `src/tools/webTools.ts`
- Jina renders JS-heavy pages server-side and returns clean markdown
- Budget-tracked via shared `usage.fetches` counter
- **Indexes directly into RAG store** on successful fetch — no model extraction needed
- Falls back to `failedUrls` set on error or empty response

**Budget enforcement (hard stop)**

A shared `usage` object (`{ searches, fetches, indexed }`) is mutated by both tools:
- `isBudgetExhausted()` — stops the agent loop when both budgets are spent
- `getIndexedCount()` — returned to orchestrator so it knows whether to run synthesizer

```typescript
stopWhen: [stepCountIs(maxSteps), (_opts) => researcherCtx.isBudgetExhausted()]
```

### Synthesizer tools (`src/orchestrator/runner/tools/searchDocumentsTool.ts`)

**search_documents**
- Calls `ragStore.searchDocuments(query, max_results)` directly
- No MCP server needed — RAG store is injected as a closure
- Serialised via a promise-chain mutex to prevent parallel calls
  (Gemini fires tool calls concurrently; sequential execution is required for the ReAct observe-then-decide loop)

```typescript
// Mutex pattern
let searchQueue = Promise.resolve()
execute: ({ query }) => {
  const result = searchQueue.then(async () => await ragStore.searchDocuments(query))
  searchQueue = result.then(() => {}, () => {})
  return result
}
```

---

## Content flow

```text
researcher
  - WebSearch returns URL/title/snippet
  - WebFetch → Jina Reader → clean markdown
  - WebFetch tool indexes content directly into ragStore (code, no model)
  - model emits <<<SOURCE>>> markers (URL + Title only) for deduplication tracking

orchestrator (code)
  - parses <<<SOURCE>>> markers
  - deduplicates against previously covered URLs
  - indexResearchOutput() is now a no-op (just counts markers)

synthesizer
  - calls search_documents (direct ragStore call, no MCP)
  - answers from retrieved chunks
```

Key difference from Claude runner: **indexing happens inside the WebFetch tool**, not after the researcher completes. The model never sees or compresses the fetched content — it just receives "Fetched and indexed: <url>" as confirmation.

---

## Cost profile

| Component | Model | Typical cost/run |
|-----------|-------|-----------------|
| Researcher | gemini-2.5-flash | ~$0.001–0.005 |
| Synthesizer | gemini-2.5-flash | ~$0.001–0.005 |
| Total | | ~$0.003–0.015 |

~10–25x cheaper than the Claude runner for equivalent query complexity.

Gemini 2.5 Flash pricing (per 1M tokens): $0.10 input / $0.40 output.

---

## Key env vars

```
AGENT_PROVIDER=vercel
GOOGLE_GENERATIVE_AI_API_KEY=...
TAVILY_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash   # default
```

---

## Known limitations

| Issue | Status |
|-------|--------|
| Gemini parallelises tool calls by default | Fixed via mutex in synthesizer |
| JS-heavy pages (AllTrails, TripAdvisor) | Mostly fixed by Jina Reader; some still return thin content |
| Budget stop only triggers when both search AND fetch are exhausted | By design — partial budget use is fine |
| No MCP server support | Not needed; tools injected directly as closures |

---

## Tradeoffs vs Claude runner

| | Vercel runner | Claude runner |
|---|---|---|
| Web tools | Custom (Tavily + Jina) | Native (platform-managed) |
| Content extraction | Code (Jina Reader, indexed in tool) | Model (may compress/summarize) |
| JS-heavy pages | Handled by Jina | Depends on SDK |
| Cost/run | ~$0.003–0.015 | ~$0.10–0.19 |
| MCP support | Not needed | Native |
| Model flexibility | Any model via Vercel AI SDK | Claude only |
