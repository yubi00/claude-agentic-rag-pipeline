# Runner: Strands Agents (TypeScript SDK) + OpenAI

Implementation: `src/orchestrator/runner/strandsAgentRunner.ts`

Set `AGENT_PROVIDER=strands` to use this runner.

---

## How it works

```text
strandsAgentRunner.run(agent, prompt, runtime, budget)
  |
  v
model = new OpenAIModel({ api: 'chat', modelId: OPENAI_MODEL, apiKey: OPENAI_API_KEY })
  |
  v
tools = researcher ? [WebSearch, WebFetch] : [search_documents]
  |
  v
agentInstance = new Agent({ model, tools, systemPrompt, printer: false })
  |
  v
agentInstance.addHook(BeforeToolCallEvent, budgetGuard)   ← hard budget stop
  |
  v
result = await agentInstance.invoke(prompt)
  → model-driven loop: model calls tools until it decides it is done
  → no explicit recursionLimit or stopWhen — model emits final answer when satisfied
  |
  v
cleanupHook()
text = result.toString()
tokens = result.metrics?.accumulatedUsage
  |
  v
AgentRunResult { text, turns, costUsd, durationMs, failedUrls, indexedCount }
```

---

## Architectural decisions

### 1. Model-driven stop — no explicit loop limit

**What's different**: Every other runner requires the caller to impose a stop condition:
- Vercel: `stopWhen: [stepCountIs(n), isBudgetExhausted]`
- LangChain: `recursionLimit: maxSteps * 2`
- Claude: `max_turns`

Strands' agent loop runs until the model itself decides it's done — it calls tools, observes results, and stops when it has enough to answer. No external loop counter is needed.

**Tradeoff**: Less predictable worst-case duration. Mitigated by the budget hook below.

---

### 2. Hard budget stop via `BeforeToolCallEvent` hook

**Problem**: With no `stopWhen` equivalent, we need a way to enforce the budget at the framework level rather than relying on the model to honour "budget exhausted" strings.

**Decision**: Hook `BeforeToolCallEvent` and set `event.cancel` to a descriptive string when the budget is spent. This fires *before* the tool callback runs — no wasted API call, no model compliance required:

```typescript
const cleanupHook = agentInstance.addHook(BeforeToolCallEvent, (event) => {
    if (event.toolUse.name === 'WebSearch' && usage.searches >= maxSearches) {
        event.cancel = 'Search budget exhausted — no more web searches allowed.'
    } else if (event.toolUse.name === 'WebFetch' && usage.fetches >= maxFetches) {
        event.cancel = 'Fetch budget exhausted — no more page fetches allowed.'
    } else {
        steps++
    }
})
```

The cancelled string becomes the tool result that the model sees. With all tools cancelled, the model has no choice but to produce a final answer.

**This is the cleanest budget stop of all four runners**. Vercel's `stopWhen` is comparable (framework-level), but the hook approach is more granular — individual tools can be stopped independently while others remain available.

**Cleanup**: `addHook` returns a `HookCleanup` function. Call it after `invoke()` completes (both success and error paths) to avoid memory leaks.

---

### 3. Sequential tool execution — no mutex needed

**Finding from SDK types**: The `executeTools` private method in the Strands TypeScript SDK is explicitly documented "Executes tools sequentially and streams all tool events." The TypeScript SDK does not parallelise tool calls.

**Decision**: No promise-chain mutex in `searchDocumentsTool.ts`. This is the opposite of the Vercel runner where Gemini fires parallel calls and the synthesizer's `search_documents` needs serialisation.

**Note**: The Python Strands SDK supports concurrent execution. This distinction is TypeScript SDK-specific — do not assume it applies if porting to Python.

---

### 4. Token usage from `result.metrics` — cleanest of all runners

**Problem**: Each runner gets token counts differently:
- Claude: `result.usage` on the result object
- Vercel: `result.totalUsage`
- LangChain: `handleLLMEnd` callback with fragile multi-field fallbacks (`inputTokenCount ?? input_tokens ?? promptTokens`)

**Decision**: Strands provides token counts natively on `AgentResult`:

```typescript
const inputTokens = result.metrics?.accumulatedUsage.inputTokens ?? 0
const outputTokens = result.metrics?.accumulatedUsage.outputTokens ?? 0
```

`accumulatedUsage` sums across all model calls in the loop — no accumulation needed in user code.

---

### 5. `result.toString()` for text extraction

**Finding from SDK types**: `AgentResult.toString()` "extracts and concatenates all text content from the last message. Includes text from TextBlock and ReasoningBlock content blocks."

No content-array mapping needed (unlike LangChain's `content.map(b => b.text)`). Clean single call.

---

### 6. `printer: false` to suppress Strands' built-in output

**Problem**: `Agent` defaults to `printer: true`, which prints text generation, reasoning, and tool usage to the console as they occur. This conflicts with our own structured logging and ANSI color output.

**Decision**: Always pass `printer: false`. All console output is handled by our runner and tool factories.

---

### 7. Confidence block works without human-turn reinforcement

**Context**: The LangChain runner needed an explicit JSON block reminder appended to the synthesizer's human message because Gemini in ReAct mode didn't reliably follow system-prompt-only instructions.

**Finding**: OpenAI models (gpt-4o-mini) follow the synthesizer's system prompt JSON block instruction reliably. No human-turn workaround needed.

**Decision**: Pass `prompt` directly to `agent.invoke()` without modification. If a future model swap causes the confidence block to be missed, the same human-turn reminder pattern from the LangChain runner can be applied.

---

### 8. `OpenAIModel` requires `api: 'chat'`

**Finding from SDK types**: `OpenAIModelOptions` requires `api: OpenAIApi` where the only supported value is `'chat'`. This is not optional and must be passed explicitly:

```typescript
new OpenAIModel({
    api: 'chat',          ← required, not optional
    modelId: OPENAI_MODEL,
    apiKey: OPENAI_API_KEY,
    temperature: 0,
})
```

`apiKey` defaults to `process.env.OPENAI_API_KEY`. We pass it explicitly from `src/config/env.ts` for consistency with the other runners.

---

## Tool file structure

```
src/
├── tools/
│   └── webTools.ts                            ← shared SDK-agnostic, unchanged
└── orchestrator/runner/
    ├── strandsAgentRunner.ts                  ← runner entry point
    └── tools/
        └── strands/
            ├── webSearchTool.ts               ← tool() wrapper for WebSearch
            ├── webFetchTool.ts                ← tool() wrapper for WebFetch
            └── searchDocumentsTool.ts         ← tool() wrapper for search_documents (no mutex)
```

Strands' `tool()` function uses a `callback` field where Vercel uses `execute`. Otherwise the pattern is identical — both accept a Zod `inputSchema` and return a typed invokable tool.

---

## Content flow

Identical to Vercel and LangChain runners:

```text
researcher
  ↓ WebSearch  → tavilySearch() → snippets indexed (if ≥20 words, not in indexedUrls)
  ↓ WebFetch   → jinaFetch()   → full markdown page indexed (if not in indexedUrls)
  ↓ model emits <<<SOURCE>>> markers (URL + Title) for orchestrator dedup tracking

orchestrator
  ↓ parses <<<SOURCE>>> markers → deduplicates against previouslyCovered
  ↓ sourceCount = researcher.indexedCount
  ↓ if sourceCount == 0 → skip synthesizer, retry

synthesizer
  ↓ search_documents (direct ragStore call — no mutex, sequential by design)
  ↓ composes cited answer + JSON confidence block (no human-turn reinforcement needed)
```

---

## Cost profile

| Component | Model | Typical cost/run |
|-----------|-------|-----------------|
| Researcher | gpt-4o-mini | ~$0.001–0.003 |
| Synthesizer | gpt-4o-mini | ~$0.001–0.002 |
| Total | | ~$0.002–0.005 |

OpenAI gpt-4o-mini pricing: $0.15/1M input, $0.60/1M output.
Similar cost to Gemini runners. Use `OPENAI_MODEL=gpt-4o` for higher quality (~17x more expensive).

---

## Key env vars

```
AGENT_PROVIDER=strands
OPENAI_API_KEY=...          ← reads OPENAI_API_KEY by default; passed explicitly for clarity
OPENAI_MODEL=gpt-4o-mini    ← default
TAVILY_API_KEY=...
```

---

## Tradeoffs vs other runners

| | Strands | Vercel | LangChain | Claude |
|---|---|---|---|---|
| Loop control | Model-driven | `stopWhen` | `recursionLimit` | `max_turns` |
| Budget stop | `BeforeToolCallEvent` hook (precise, per-tool) | `stopWhen` (precise, per-loop) | Tool string + recursion limit (coarse) | `max_turns` |
| Tool execution | Sequential | Parallel | Sequential (ReAct) | Parallel |
| Mutex needed | No | Yes (synthesizer) | No | No |
| Confidence block | Works (OpenAI reliable) | Works (Gemini reliable) | Needs human-turn fix | Works (Claude reliable) |
| Token tracking | `result.metrics` (cleanest) | `result.totalUsage` | LLM callback (fragile) | `result.usage` |
| Text extraction | `result.toString()` (clean) | `result.text` | Content array map | Text stream collect |
| Cost/run | ~$0.002–0.005 | ~$0.003–0.015 | ~$0.003–0.015 | ~$0.10–0.19 |
| Duration | ~70–90s (gpt-4o-mini) | ~35–55s (Gemini) | ~30–45s (Gemini) | ~45–70s |
| SDK maturity | Experimental (TS) | Stable | Stable | Stable |

---

## Known limitations

| Issue | Status |
|-------|--------|
| TypeScript SDK is experimental — breaking changes expected | Use with caution in prod |
| Slower than Gemini runners due to gpt-4o-mini latency | Swap to `gpt-4o` for quality, accept cost |
| No parallelism — sequential tools mean more wall-clock time per iteration | By design in TS SDK |
| Python Strands SDK behaves differently (concurrent tools) | Do not assume TS behaviour applies |
