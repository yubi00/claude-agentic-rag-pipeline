# Runner: LangChain.js + Gemini

Implementation: `src/orchestrator/runner/langchainAgentRunner.ts`

Set `AGENT_PROVIDER=langchain` to use this runner.

---

## How it works

```text
langchainAgentRunner.run(agent, prompt, runtime, budget)
  |
  v
tools = researcher ? [WebSearch, WebFetch] : [search_documents]
  |
  v
model = new ChatGoogleGenerativeAI({
  model: GEMINI_MODEL,
  temperature: 0,
  apiKey: GOOGLE_GENERATIVE_AI_API_KEY,   ← must pass explicitly (see decision #2)
})

agentInstance = createReactAgent({
  llm: model,
  tools,
  prompt: systemPrompt,                   ← becomes the system message
})
  |
  v
agentInstance.invoke(
  { messages: [new HumanMessage(humanContent)] },
  { recursionLimit: maxSteps * 2 }        ← hard cap (see decision #5)
)
  → ReAct loop: Thought → Action → Observation → Thought → ...
  → stops when model emits final answer or recursionLimit is reached
  |
  v
AgentRunResult { text, turns, costUsd, durationMs, failedUrls, indexedCount }
```

---

## Architectural decisions

### 1. `createReactAgent` from `@langchain/langgraph/prebuilt`, not `langchain/agents`

**Problem**: LangChain has multiple agent implementations across different packages. The original plan used `AgentExecutor` from `langchain/agents`, but this is the legacy path. The modern LangChain stack (LangGraph-based) uses `createReactAgent` from `@langchain/langgraph/prebuilt`.

**Decision**: Use `createReactAgent` from `@langchain/langgraph/prebuilt` directly — no `AgentExecutor` wrapper. This gives access to LangGraph's state graph under the hood, better streaming support, and aligns with LangChain's current direction.

```typescript
import { createReactAgent } from '@langchain/langgraph/prebuilt'
// NOT: import { AgentExecutor, createReactAgent } from 'langchain/agents'
```

**Tradeoff**: `@langchain/langgraph` is a separate package from `langchain`. Adds a dependency but is the correct modern import.

---

### 2. Pass `apiKey` explicitly to `ChatGoogleGenerativeAI`

**Problem**: `@langchain/google-genai` reads from `process.env.GOOGLE_API_KEY` by default. Our `.env` uses `GOOGLE_GENERATIVE_AI_API_KEY` (the key name used by the Vercel AI SDK and `@google/generative-ai`). Without explicit passing, the model initializes but fails at runtime with an auth error.

**Decision**: Always pass `apiKey` explicitly in the constructor:

```typescript
const model = new ChatGoogleGenerativeAI({
    model: GEMINI_MODEL,
    temperature: 0,
    apiKey: GOOGLE_GENERATIVE_AI_API_KEY,   ← from src/config/env.ts
})
```

**Why this matters**: Two different env var conventions exist (`GOOGLE_API_KEY` vs `GOOGLE_GENERATIVE_AI_API_KEY`). Centralising env var access in `src/config/env.ts` and passing explicitly removes any ambiguity regardless of which convention the package uses internally.

---

### 3. Sequential ReAct loop — no mutex needed

**Problem**: The Vercel runner required a promise-chain mutex to serialize `search_documents` calls because Gemini fires parallel tool calls via Vercel's `ToolLoopAgent`.

**Decision**: No mutex in the LangChain runner. LangChain's ReAct (Reasoning + Acting) loop is strictly sequential by design:

```
Thought: What should I search for first?
Action: search_documents("query A")
Observation: [results]
Thought: Now I need to search for angle B.
Action: search_documents("query B")
Observation: [results]
...
Final Answer: [composed response]
```

The model can only emit one action per step. This eliminates the parallel-call problem entirely, at the cost of speed (see tradeoffs).

---

### 4. Confidence block requires human-turn reinforcement

**Problem**: The synthesizer system prompt says "REQUIRED: End your response with EXACTLY this JSON block." This works reliably with Claude (strong instruction following) but Gemini in LangChain's ReAct context was ignoring it. The synthesizer consistently returned `LOW` confidence because `parseConfidenceBlock()` found no JSON block and fell back to the default.

**Root cause**: LangChain's `createReactAgent` wraps the system prompt with ReAct format instructions. The trailing JSON block requirement — placed at the end of a long system prompt — gets de-prioritized by Gemini when it's already focused on the ReAct output format.

**Decision**: Append an explicit JSON block reminder to the human message specifically when the agent is `synthesizer`:

```typescript
const humanContent = agent === 'synthesizer'
    ? `${prompt}\n\nIMPORTANT: After your complete answer, you MUST append the JSON confidence block exactly as shown in your instructions. It must be the LAST thing in your response.`
    : prompt
```

**Why not modify the system prompt**: The system prompt is shared with the Claude runner (`getAgentPrompt(agent)`). Modifying it would affect Claude's behavior too. The human-turn injection is LangChain-runner-specific.

---

### 5. `recursionLimit` as the hard stop (no `stopWhen` equivalent)

**Problem**: Vercel's `ToolLoopAgent` supports a custom `stopWhen` callback — a framework-level hard stop that fires before the model makes another call. LangChain's `createReactAgent` has no equivalent.

**Decision**: Use `recursionLimit` from LangGraph's invocation config as the hard cap. Budget exhaustion is handled at the tool level by returning a terminal string:

```typescript
// In WebSearch tool:
if (usage.searches >= maxSearches) return 'Search budget exhausted.'

// In the runner:
agentInstance.invoke(
    { messages: [...] },
    { recursionLimit: maxSteps * 2 }   // each ReAct step = 2 graph nodes
)
```

**Why `maxSteps * 2`**: LangGraph counts graph node transitions, not tool calls. Each ReAct step (agent → tool → agent) traverses 2 nodes. `maxSteps * 2` translates the step budget into the graph's recursion units.

**Limitation vs Vercel**: The budget exhaustion string is advisory — the model _should_ stop calling tools after receiving it, but isn't forced to. The `recursionLimit` is the actual hard stop, but it's coarser than Vercel's `stopWhen`.

---

### 6. Extract text from content array

**Problem**: LangChain's `createReactAgent` returns an array of message objects. The final `AIMessage` has a `.content` field that can be either a `string` or an array of content blocks:

```json
[{"type": "text", "text": "The answer is..."}]
```

Returning this array directly as the `text` field of `AgentRunResult` caused the orchestrator to receive a JSON stringification of the array instead of the actual answer.

**Decision**: Normalise the content field in the runner before returning:

```typescript
const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
        ? content.map((b) =>
            typeof b === 'string' ? b
            : ('text' in b && typeof b.text === 'string') ? b.text
            : ''
          ).join('')
        : String(content ?? '')
```

The `'text' in b && typeof b.text === 'string'` type guard avoids a TypeScript error on the heterogeneous content block union type.

---

### 7. Shared `indexedUrls` set for deduplication across tool calls

**Problem**: The researcher runs multiple searches in a single agent invocation. The same URL can appear in the results of different queries. Without deduplication, the same snippet or page would be indexed into the RAG store multiple times, wasting Neon write quota and producing duplicate chunks in search results.

**Decision**: Create a single `Set<string>` per agent run, shared between `WebSearch` and `WebFetch`:

```typescript
const indexedUrls = new Set<string>()

createWebSearchTool(color, usage, maxSearches, runtime.ragStore, indexedUrls)
createWebFetchTool(color, usage, maxFetches, failedUrls, runtime.ragStore, indexedUrls)
```

Both tools check `indexedUrls.has(url)` before calling `ragStore.addDocument()` and add the URL after indexing. This also prevents a URL pre-indexed as a snippet (via WebSearch) from being re-indexed when later fetched in full (via WebFetch).

---

## Tool file structure

```
src/
├── tools/
│   └── webTools.ts                            ← shared SDK-agnostic: tavilySearch, jinaFetch
└── orchestrator/runner/
    ├── langchainAgentRunner.ts                ← runner entry point
    └── tools/
        └── langchain/
            ├── webSearchTool.ts               ← DynamicStructuredTool wrapper for WebSearch
            ├── webFetchTool.ts                ← DynamicStructuredTool wrapper for WebFetch
            └── searchDocumentsTool.ts         ← DynamicStructuredTool wrapper for search_documents
```

`DynamicStructuredTool` is LangChain's tool wrapper equivalent to Vercel's `tool<INPUT, OUTPUT>()`. Both use Zod schemas for input validation.

---

## Content flow

Identical to the Vercel runner:

```text
researcher
  ↓ WebSearch  → tavilySearch() → snippets indexed (if ≥20 words, not already in indexedUrls)
  ↓ WebFetch   → jinaFetch()   → full markdown page indexed (if not already in indexedUrls)
  ↓ model emits <<<SOURCE>>> markers (URL + Title) for orchestrator dedup tracking

orchestrator
  ↓ parses <<<SOURCE>>> markers → deduplicates against previouslyCovered
  ↓ sourceCount = researcher.indexedCount
  ↓ if sourceCount == 0 → skip synthesizer, retry

synthesizer
  ↓ search_documents (direct ragStore call — no mutex needed, ReAct is sequential)
  ↓ composes cited answer + JSON confidence block (reinforced via human-turn reminder)
```

---

## Token usage tracking

LangChain doesn't expose token counts on the final result object. Instead, we hook into the LLM callback system:

```typescript
callbacks: [{
    handleLLMEnd(output: { llmOutput?: Record<string, unknown> }) {
        const u = (output.llmOutput?.usageMetadata ?? output.llmOutput?.tokenUsage) as Record<string, number> | undefined
        inputTokens += u?.inputTokenCount ?? u?.input_tokens ?? u?.promptTokens ?? 0
        outputTokens += u?.outputTokenCount ?? u?.output_tokens ?? u?.completionTokens ?? 0
    },
    handleToolStart() { steps++ },
}]
```

The multiple field name fallbacks (`inputTokenCount`, `input_tokens`, `promptTokens`) handle differences between Gemini's and other models' `llmOutput` shapes.

---

## Cost profile

| Component | Model | Typical cost/run |
|-----------|-------|-----------------|
| Researcher | gemini-2.5-flash | ~$0.001–0.005 |
| Synthesizer | gemini-2.5-flash | ~$0.001–0.005 |
| Total | | ~$0.003–0.015 |

Same model and pricing as the Vercel runner. Gemini 2.5 Flash: $0.10/1M input, $0.40/1M output.

---

## Key env vars

```
AGENT_PROVIDER=langchain
GOOGLE_GENERATIVE_AI_API_KEY=...    ← must match — passed explicitly (not GOOGLE_API_KEY)
TAVILY_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

---

## Known limitations

| Issue | Status |
|-------|--------|
| No framework-level `stopWhen` | Mitigated by tool-level exhaustion strings + `recursionLimit` |
| Sequential tool execution (slower than parallel) | By design — ReAct constraint |
| Gemini confidence block unreliable in ReAct | Fixed via human-turn reinforcement |
| Token field names differ per model | Fixed via multi-field fallback in callback |

---

## Tradeoffs vs other runners

| | LangChain | Vercel | Claude |
|---|---|---|---|
| Tool execution | Sequential (ReAct) | Parallel | Parallel |
| Hard budget stop | `recursionLimit` (coarse) | `stopWhen` (precise) | `max_turns` |
| Parallel tool mutex | Not needed | Needed + implemented | Not needed |
| Confidence block | Human-turn reinforcement | System prompt sufficient | System prompt sufficient |
| Instruction following | Gemini (needs reinforcement) | Gemini (needs reinforcement) | Claude (reliable) |
| Content extraction | Code (Jina, in tool) | Code (Jina, in tool) | Model |
| Cost/run | ~$0.003–0.015 | ~$0.003–0.015 | ~$0.10–0.19 |
| Step visibility | Explicit (Thought/Action/Obs) | Opaque (tool loop) | Opaque (tool loop) |
