# Architecture: claude-agentinc-rag

Agentic RAG research pipeline with a provider-agnostic agent runner interface.

The architecture is **code-controlled, not prompt-controlled**. The runtime executes a deterministic sequence:

1. `researcher` gathers web evidence and indexes directly into the RAG store (via tools, no model extraction)
2. orchestrator parses SOURCE markers for deduplication and decides whether to run the synthesizer
3. `synthesizer` answers from indexed knowledge only via vector search
4. orchestrator parses the confidence block and decides whether to stop or run another research pass

---

## Runner implementations

The pipeline is provider-agnostic. The orchestrator only sees `IAgentRunner` — it has no knowledge of which SDK or model is in use.

| Runner | SDK | Model | Doc |
|--------|-----|-------|-----|
| `ClaudeAgentRunner` | Claude Agent SDK | Claude Haiku / Sonnet / Opus | [docs/runner-claude.md](docs/runner-claude.md) |
| `VercelAgentRunner` | Vercel AI SDK | Gemini 2.5 Flash | [docs/runner-vercel.md](docs/runner-vercel.md) |
| `LangChainAgentRunner` | LangChain.js + LangGraph | Gemini 2.5 Flash | [docs/runner-langchain.md](docs/runner-langchain.md) |
| `StrandsAgentRunner` | Strands Agents (TS SDK) | gpt-4o-mini | [docs/runner-strands.md](docs/runner-strands.md) |

Adding a new runner means implementing `IAgentRunner` only — the orchestrator, RAG store, and agent prompts are unchanged.

Set `AGENT_PROVIDER=claude|vercel|langchain|strands` to select the active runner.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Map](#component-map)
3. [Data Flow](#data-flow)
4. [Iteration Control](#iteration-control)
5. [Agent Definitions](#agent-definitions)
6. [RAG Runtime](#rag-runtime)
7. [Key Configuration](#key-configuration)
8. [Key Architectural Decisions](#key-architectural-decisions)
9. [Prompt Caching](#prompt-caching)
10. [Agent Memory](#agent-memory)

---

## System Overview

The CLI bootstraps a RAG runtime explicitly at startup, then passes that runtime into the orchestrator. The orchestrator owns only session flow and iteration policy; agent execution, planning, output rendering, and research-output processing live in smaller modules.

```text
User
  |
  v
src/index.ts
  - reads CLI question
  - validates env (provider-specific keys only)
  - calls initializeRagRuntime()
  - constructs IAgentRunner (selected via AGENT_PROVIDER)
  - calls runResearchSession(question, runtime, runner)
  |
  v
src/rag/index.ts
  - creates local embedder
  - creates NeonVectorStore (pgvector)
  - initializes store
  - creates in-process MCP server
  - returns { ragStore, ragServer }
  |
  v
src/orchestrator/index.ts
  - runs deterministic iteration loop
  - researcher → index (code) → synthesizer
  - parses confidence block
  - retries only when policy says to retry
```

---

## Component Map

```text
claude-agentinc-rag/
├── src/
│   ├── index.ts                         # CLI entry point
│   ├── config/
│   │   └── env.ts                       # Central env config — all process.env access here
│   ├── agents/
│   │   ├── researcher.ts                # Web evidence gathering prompt + AgentDefinition
│   │   └── synthesizer.ts               # Retrieval + answer prompt + AgentDefinition
│   ├── orchestrator/
│   │   ├── index.ts                     # Session loop (outer orchestrator)
│   │   ├── config.ts                    # Agent model + toolset config
│   │   ├── planner.ts                   # Research task builder and stop policy
│   │   ├── presenter.ts                 # Terminal rendering
│   │   ├── researchOutput.ts            # SOURCE parsing, dedupe, indexing
│   │   ├── limiter.ts                   # Web tool budget hooks (Claude runner only)
│   │   ├── toolConfig.ts                # Tool allow/deny lists (Claude runner only)
│   │   ├── types.ts                     # Shared orchestrator types
│   │   └── runner/
│   │       ├── interface.ts             # IAgentRunner contract
│   │       ├── claudeAgentRunner.ts     # Claude Agent SDK runner
│   │       ├── vercelAgentRunner.ts     # Vercel AI SDK + Gemini runner
│   │       ├── vercelTools.ts           # Vercel tool set wiring
│   │       ├── langchainAgentRunner.ts  # LangChain.js + LangGraph runner
│   │       ├── strandsAgentRunner.ts    # Strands Agents (TS SDK) + OpenAI runner
│   │       └── tools/
│   │           ├── webSearchTool.ts          # Vercel: WebSearch
│   │           ├── webFetchTool.ts           # Vercel: WebFetch
│   │           ├── searchDocumentsTool.ts    # Vercel: search_documents (with mutex)
│   │           ├── langchain/
│   │           │   ├── webSearchTool.ts      # LangChain: WebSearch
│   │           │   ├── webFetchTool.ts       # LangChain: WebFetch
│   │           │   └── searchDocumentsTool.ts # LangChain: search_documents
│   │           └── strands/
│   │               ├── webSearchTool.ts      # Strands: WebSearch
│   │               ├── webFetchTool.ts       # Strands: WebFetch
│   │               └── searchDocumentsTool.ts # Strands: search_documents
│   ├── rag/
│   │   ├── index.ts                     # RAG runtime bootstrap
│   │   ├── server.ts                    # In-process MCP server factory
│   │   ├── neon-store.ts                # Active pgvector-backed store
│   │   ├── vector-store.ts              # Alternative in-memory vector store
│   │   ├── minisearch-store.ts          # Alternative BM25 in-process store
│   │   ├── interface.ts                 # IRagStore contract
│   │   └── errors.ts                    # RAG-specific error types
│   ├── tools/
│   │   └── webTools.ts                  # SDK-agnostic: tavilySearch, jinaFetch (shared)
│   ├── libs/
│   │   ├── ansi.ts                      # Terminal color helpers
│   │   └── logger.ts                    # Pino structured logger
│   └── utils/
│       └── index.ts                     # parseConfidenceBlock, extractText helpers
└── docs/
    ├── runner-claude.md
    ├── runner-vercel.md
    ├── runner-langchain.md
    └── runner-strands.md
```

---

## Data Flow

```text
Question
  |
  v
initializeRagRuntime()
  +--> NeonVectorStore (pgvector, persistent)
  +--> in-process MCP server (backed by ragStore)
  |
  v
runResearchSession(question, runtime, runner)
  |
  +--> optional clearDocuments()
  |
  +--> iteration 1..MAX_ITERATIONS
         |
         +--> buildResearchTask(question, iteration, previousConfidence, previouslyCovered)
         |
         +--> runner.run('researcher', task, runtime, budget)
         |      ↓ [inside runner — LangGraph / ToolLoopAgent / Strands loop]
         |      WebSearch → tavilySearch() → index snippets into ragStore
         |      WebFetch  → jinaFetch()   → index full page into ragStore
         |      model emits <<<SOURCE>>> markers (URL + Title only)
         |      returns AgentRunResult { text, indexedCount, failedUrls }
         |
         +--> dedupeResearchOutput() — remove previously covered SOURCE blocks
         +--> extractSourceUrls()    — add new URLs to previouslyCovered
         |
         +--> if indexedCount == 0:
         |      skip synthesizer, log warning, retry or stop
         |
         +--> runner.run('synthesizer', prompt, runtime)
         |      ↓ [inside runner — LangGraph / ToolLoopAgent / Strands loop]
         |      search_documents → ragStore.searchDocuments() (vector search)
         |      compose cited answer + trailing JSON confidence block
         |      returns AgentRunResult { text }
         |
         +--> parseConfidenceBlock(text) → { confidence, missingTopics, coverageNotes }
         +--> stripConfidenceBlock(text) → finalAnswer
         +--> shouldStop(iteration, confidence, deepResearch) → stop or loop
  |
  v
renderFinalAnswer(answer, confidence, totals, iterations)
```

---

## Iteration Control

Implemented in code in `src/orchestrator/index.ts`. Not delegated to the model.

### Stop policy

Default mode (`DEEP_RESEARCH=false`):
```
high   → stop
medium → stop
low    → retry until MAX_ITERATIONS
```

Deep research mode (`DEEP_RESEARCH=true`):
```
high         → stop
medium / low → retry until MAX_ITERATIONS
```

### Research passes

**Iteration 1** (initial):
- broad queries, higher fetch/search budget (`INITIAL_WEB_FETCHES`, `INITIAL_WEB_SEARCHES`)

**Iteration 2+** (gap-filling):
- targeted queries from `missingTopics`
- smaller budget (`GAP_WEB_FETCHES`, `GAP_WEB_SEARCHES`)
- deduplication against `previouslyCovered` URLs

### No-source guard

If `indexedCount == 0` after deduplication, the orchestrator skips synthesis for that pass and treats confidence as LOW. Avoids wasting synthesizer tokens when the researcher found nothing new.

---

## Agent Definitions

### Researcher

File: `src/agents/researcher.ts`

- **Tools**: `WebSearch`, `WebFetch`
- **Responsibility**: gather external evidence, index it into the RAG store via tools, emit `<<<SOURCE>>>` markers for deduplication tracking
- **Input**: JSON task with queries, context, gap-filling flag, previously covered URLs, fetch budget
- **Output**: `<<<SOURCE>>>` blocks (URL + Title only) + `RESEARCH SUMMARY`

Key behaviours:
- Indexing happens **inside the tool**, not in the model output — content goes to RAG verbatim, model only sees `"Fetched and indexed: url"` confirmation
- Budget enforced at framework level (`stopWhen` / hook / `recursionLimit`) — model cannot overspend
- Deduplication via shared `indexedUrls` set prevents the same URL being indexed twice within one run

### Synthesizer

File: `src/agents/synthesizer.ts`

- **Tools**: `search_documents` (RAG store only)
- **Responsibility**: answer from indexed knowledge, no web access
- **Input**: original question or `KNOWN GAPS: [list]\n\nQuestion: [question]`
- **Output**: cited answer + required trailing JSON confidence block

Key behaviours:
- Multiple search angles, query rewriting on weak results
- Stricter confidence rules for time-sensitive / event-style queries
- Confidence block parsed by orchestrator to drive iteration decisions

---

## RAG Runtime

Active backend: **Neon Postgres with pgvector** (`src/rag/neon-store.ts`)

### Bootstrap

```text
initializeRagRuntime()
  1. createLocalEmbedder()    ← all-MiniLM-L6-v2, 384 dimensions, runs in-process
  2. new NeonVectorStore(DATABASE_URL, embedFn)
  3. store.initialize()       ← creates table + index if not exists
  4. createRagServer(store)   ← in-process MCP server (Claude runner only)
  → { ragStore, ragServer }
```

### Store interface (`src/rag/interface.ts`)

```typescript
interface IRagStore {
  addDocument(doc: { url, title, content }): Promise<void>
  searchDocuments(query, maxResults): Promise<SearchResult>
  clearDocuments(): Promise<void>
  listDocuments(): Promise<Document[]>
}
```

### MCP server (`src/rag/server.ts`)

Exposed tools: `index_document`, `search_documents`, `list_indexed`, `clear_index`

Used by the Claude runner only — other runners inject `ragStore` directly as a closure into tool functions.

### Alternative backends

| Store | File | Use case |
|-------|------|----------|
| NeonVectorStore | `neon-store.ts` | Production, persistent, pgvector |
| VectorStore | `vector-store.ts` | In-memory, no DB, local embeddings |
| MiniSearchStore | `minisearch-store.ts` | In-process BM25, zero external deps |

Switch in `src/rag/index.ts`.

---

## Key Configuration

All env vars centralised in `src/config/env.ts`. `validateEnv()` runs at startup and throws early if provider-required keys are missing.

### Session controls

| Var | Default | Effect |
|-----|---------|--------|
| `AGENT_PROVIDER` | `vercel` | Active runner: `claude`, `vercel`, `langchain`, `strands` |
| `DEEP_RESEARCH` | `false` | If true, retries on medium confidence too |
| `MAX_RESEARCH_ITERATIONS` | `3` | Hard cap on researcher/synthesizer cycles |
| `CLEAR_RAG_ON_START` | `true` | Wipe RAG store before each session |
| `INITIAL_WEB_FETCHES` | `5` | Fetch budget for iteration 1 |
| `GAP_WEB_FETCHES` | `3` | Fetch budget for iterations 2+ |
| `INITIAL_WEB_SEARCHES` | `5` | Search budget for iteration 1 |
| `GAP_WEB_SEARCHES` | `3` | Search budget for iterations 2+ |

### Provider-specific keys

| Provider | Required keys |
|----------|--------------|
| `claude` | `ANTHROPIC_API_KEY` |
| `vercel` | `GOOGLE_GENERATIVE_AI_API_KEY`, `TAVILY_API_KEY` |
| `langchain` | `GOOGLE_GENERATIVE_AI_API_KEY`, `TAVILY_API_KEY` |
| `strands` | `OPENAI_API_KEY`, `TAVILY_API_KEY` |
| All | `DATABASE_URL` |

### Model overrides

| Var | Default | Used by |
|-----|---------|---------|
| `GEMINI_MODEL` | `gemini-2.5-flash` | vercel, langchain |
| `OPENAI_MODEL` | `gpt-4o-mini` | strands |
| `AGENT_MODEL` | `claude-haiku-4-5-20251001` | claude (base) |
| `RESEARCHER_MODEL` | `AGENT_MODEL` | claude |
| `SYNTHESIZER_MODEL` | `AGENT_MODEL` | claude |

---

## Key Architectural Decisions

### 1. Code-enforced orchestration, not prompt-enforced

The researcher → synthesizer sequence and the confidence-based loop are enforced in TypeScript code, not left to the model's discretion. The model cannot skip synthesis, loop back early, or run agents out of order.

### 2. Direct RAG indexing in tools (not post-run extraction)

Early design had the researcher model emit full page content in `SOURCE` blocks, which the orchestrator would parse and index. This failed because:
- The model compressed content during extraction (losing factual detail)
- Large pages caused summarisation rather than verbatim preservation
- The model sometimes forgot to emit SOURCE blocks

**Fix**: content is indexed inside the tool `execute`/`callback` function immediately after `jinaFetch()` returns. The model only receives `"Fetched and indexed: url"` — it never touches the raw content.

### 3. Provider-agnostic runner via `IAgentRunner`

The orchestrator only calls `runner.run(agent, prompt, runtime, budget)` and receives `AgentRunResult`. Four implementations exist (Claude, Vercel, LangChain, Strands) — they share no code except `src/tools/webTools.ts`.

### 4. SDK-agnostic web tools core

`src/tools/webTools.ts` contains the actual HTTP logic for Tavily search and Jina fetch with no framework imports. All four runners import the same functions — only the wrapper (`tool()`, `DynamicStructuredTool`, `callback`) differs per SDK.

### 5. Parallel tool execution needs a mutex (Vercel only)

Gemini via Vercel's `ToolLoopAgent` fires multiple tool calls in parallel. The synthesizer's `search_documents` must be serialised to preserve the observe-then-decide reasoning loop. Fixed via a promise-chain mutex:

```typescript
let searchQueue = Promise.resolve()
execute: ({ query }) => {
    const result = searchQueue.then(() => ragStore.searchDocuments(query))
    searchQueue = result.then(() => {}, () => {})
    return result
}
```

LangChain (ReAct sequential) and Strands (TS SDK sequential) do not need this.

### 6. Budget enforcement at framework level

Relying on the model to stop after "budget exhausted" strings is unreliable. Each runner enforces the budget differently:

| Runner | Mechanism |
|--------|-----------|
| Vercel | `stopWhen` callback — fires before next tool call |
| LangChain | Tool returns exhaustion string + `recursionLimit` as hard cap |
| Strands | `BeforeToolCallEvent` hook — cancels specific tools before execution |
| Claude | `max_turns` on `query()` + `hooks` from `limiter.ts` |

### 7. Deduplication via shared `indexedUrls` set

A `Set<string>` is created per agent run and passed to both WebSearch and WebFetch tools. Before indexing any document, both tools check this set. This prevents:
- The same URL appearing in multiple search queries being indexed twice
- A URL pre-indexed as a snippet (WebSearch) being re-indexed as a full page (WebFetch)

### 8. `<<<SOURCE>>>` delimiters for deduplication markers

Original design used `---` as SOURCE block delimiters. Jina Reader returns markdown which also uses `---` for horizontal rules, breaking the parser. Switched to `<<<SOURCE>>>` / `<<<END>>>` — characters that never appear in markdown or HTML naturally.

### 9. Our orchestrator is a hand-rolled LangGraph

The outer orchestration loop in `src/orchestrator/index.ts` is structurally equivalent to a `StateGraph`:

- **Nodes**: researcher agent, synthesizer agent
- **State**: `previouslyCovered`, `finalConfidence`, `indexedCount`, `iteration`
- **Conditional edges**: `shouldStop()`, `sourceCount === 0` guard, `MAX_ITERATIONS` cap

We chose plain TypeScript over `StateGraph` deliberately:
- The `for` loop is ~100 lines and easy to read/debug
- `IAgentRunner` gives provider-agnosticism that LangGraph's node system doesn't
- `StateGraph` would couple the orchestrator to the LangChain ecosystem

Where `StateGraph` would be worth it: if we add LangSmith observability, checkpointing/resume, or human-in-the-loop interrupts between nodes.

### 10. Strands loop vs our orchestrator loop

Strands' internal agent loop (model → tools → model → ... → end_turn) and our outer orchestrator loop are different levels:

| | Strands internal loop | Our orchestrator loop |
|--|--|--|
| What drives stopping | Model emits `end_turn` | Confidence block parsed from synthesizer output |
| Memory | Conversation history (within one agent) | RAG store (shared across agents) |
| Loops back | No — history only moves forward | Yes — researcher reruns with gap list |
| Scope | One agent, one task | Two agents, coordinated externally |

Both are running simultaneously — Strands' loop runs *inside* each `runner.run()` call, our loop runs *between* them.

---

## Prompt Caching

Prompt caching lets model providers reuse the processed KV state of a prompt prefix across calls, instead of recomputing it every time. Cache reads are ~10% of the cost of full input tokens.

### How each provider implements it

**Anthropic** — explicit opt-in via `cache_control: { type: "ephemeral" }` on message content blocks. Minimum 1024 tokens. Cached for 5 minutes (extendable). Cache read cost: ~10% of input token price. You see `cache_read_input_tokens` and `cache_creation_input_tokens` in the usage response.

**OpenAI** — fully automatic. No API changes needed. Any prompt prefix > 1024 tokens is cached for 1 hour. Cache hits appear as `cached_tokens` in the usage response. With the Strands runner using gpt-4o-mini, this is already active if prompts exceed the threshold.

**Google Gemini** — explicit `GoogleAICacheManager.create()` API call to upload content to Google's servers. Minimum **32,768 tokens** — a much higher threshold. Referenced by ID on subsequent calls via `model.useCachedContent(cachedContent)`. Designed for large static corpora, not system prompts.

### Where it would help this architecture

**System prompts** are the primary target — they're identical across every agent call and every iteration. In a multi-iteration run (LOW confidence → researcher reruns), the same system prompts are sent 2-4× per session. Caching them saves ~90% of those repeated input tokens.

```
iteration 1: researcher system prompt → full price (cache creation)
             synthesizer system prompt → full price (cache creation)

iteration 2: researcher system prompt → 10% cost (cache hit)
             synthesizer system prompt → 10% cost (cache hit)
```

**Conversation history** inside the agent loop is another target. By turn 5 of the researcher loop (5 tool calls), the model is re-reading all previous tool results. Caching the stable prefix (system prompt + early turns) means later turns only pay for new tokens.

### Why we haven't implemented it yet

**Our prompts are below every provider's minimum threshold:**

| Provider | Minimum | Researcher | Synthesizer |
|----------|---------|------------|-------------|
| Anthropic / OpenAI | 1,024 tokens | ~755 tokens | ~865 tokens |
| Gemini | 32,768 tokens | ~755 tokens | ~865 tokens |

**The Claude runner uses `query()` from the Agent SDK**, which abstracts away raw Anthropic API calls. The `cache_control` block-level parameter is not exposed — implementing it would require rewriting the Claude runner to use `Anthropic.messages.create()` directly with a custom tool loop.

**The Gemini runners (Vercel, LangChain)** don't meet Gemini's 32k minimum. Would only qualify if we switched to a RAG-in-prompt pattern (passing retrieved chunks directly in the prompt), which contradicts our design decision to keep content in the RAG store.

### When to revisit

Prompt caching becomes worthwhile when:

1. **Prompts grow beyond 1024 tokens** — adding few-shot examples, domain knowledge, or detailed tool schemas to the system prompt brings the Claude and Strands runners above the threshold with minimal architectural change
2. **Same question asked by many users concurrently** — cache hit rate compounds across concurrent callers, not just across iterations of a single session
3. **Domain-specific deployment** — a specialised deployment with a large, stable knowledge preamble baked into the system prompt is the ideal caching target
4. **Claude direct API runner** — if the Claude runner is rewritten to use `Anthropic.messages.create()` directly (for more control), `cache_control` can be added to the system prompt immediately

### Production best practices

- **Put stable content first, dynamic content last** — the cache prefix must match exactly. System prompt → few-shot examples → retrieved context → user query (never cached)
- **Track cache hit rate** — `cache_read_input_tokens / total_input_tokens` should be > 80% on repeated agent calls. Lower means prompts are varying too much between calls
- **Warm the cache proactively** — on cold start, fire a cheap dummy request to prime the cache before real traffic hits the 5-minute (Anthropic) or 1-hour (OpenAI) window
- **Cache the growing conversation history** — in multi-turn agents, mark the previous conversation as cacheable each turn so you only pay full price for the new turn

---

## Agent Memory

Memory lets agents carry knowledge forward across sessions. Without it, every session starts completely blind — the same URLs get fetched, the same pages indexed, the same tokens spent, even for questions that were answered yesterday.

### The four types

**1. In-context memory** — the conversation history within a single agent invocation. Tool results and model responses accumulated in the context window. This is what we have now. Lasts for one `runner.run()` call, managed automatically by the framework (LangGraph, Strands loop, etc.). Disappears when the call returns.

**2. Semantic memory (RAG)** — indexed facts retrieved by similarity search. Our `NeonVectorStore` *is* semantic memory — but we wipe it on every session (`CLEAR_RAG_ON_START=true`). Setting `CLEAR_RAG_ON_START=false` immediately turns it into persistent semantic memory. Risk: stale content grows unboundedly without a TTL policy.

**3. Episodic memory** — records of past sessions: what question was asked, what answer was produced, which sources were used, what confidence was reached. Lets the orchestrator recognise a repeated or similar question and return a cached answer rather than re-running the full pipeline.

**4. Procedural memory** — learned strategies: which query patterns work, which sources are high quality, which URLs consistently fail. In practice this is baked into the system prompt rather than implemented as a runtime store.

### How they map to this architecture

```
Type 1 — In-context       Already implemented. Lives inside runner.run().

Type 2 — Semantic / RAG   Infrastructure exists (NeonVectorStore).
                          Persistent with CLEAR_RAG_ON_START=false.
                          Needs TTL pruning to stay fresh.

Type 3 — Episodic         Not implemented. Would be a sessions table in Neon.
                          Orchestrator checks before running the pipeline.
                          Cache hit → return stored answer or skip researcher.

Type 4 — Procedural       Not worth implementing. Lives in system prompts.
```

### Proposed design (not yet implemented)

**Persistent RAG** — already half-done, just an env var:

```
CLEAR_RAG_ON_START=false    # keep existing docs between sessions
RAG_TTL_DAYS=7              # prune docs older than N days on startup
```

**Episodic session memory** — new `sessions` table in Neon (same DB):

```sql
CREATE TABLE sessions (
  id          SERIAL PRIMARY KEY,
  question    TEXT NOT NULL,
  embedding   vector(384),          -- for similarity lookup
  answer      TEXT NOT NULL,
  confidence  VARCHAR(10),
  sources     JSONB,
  cost_usd    FLOAT,
  iterations  INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

Orchestrator flow with memory enabled:

```text
runResearchSession(question)
  ↓
memoryStore.findSimilar(question, threshold=0.85)
  → HIGH confidence hit < 24h old  → return cached answer immediately
  → MEDIUM confidence hit < 1h old → skip researcher, run synthesizer only
  → miss                           → run full pipeline
  ↓
[pipeline runs normally]
  ↓
memoryStore.save({ question, answer, confidence, sources, cost, iterations })
```

The similarity check reuses the same local embedder already running in-process — embed the new question, cosine similarity against stored question embeddings. No extra infrastructure needed.

**Planned module structure:**

```
src/
└── memory/
    ├── interface.ts      ← IMemoryStore
    ├── neon-memory.ts    ← Neon-backed sessions table
    └── index.ts          ← initializeMemory()
```

**Planned env vars:**

```
MEMORY_ENABLED=false               # episodic memory on/off
MEMORY_TTL_HOURS=24                # how long before a cached answer is stale
MEMORY_SIMILARITY_THRESHOLD=0.85   # cosine sim to consider questions "the same"
RAG_TTL_DAYS=7                     # prune stale RAG docs on startup (persistent RAG)
```

### Why it's not implemented yet

This is a single-user CLI research tool. Memory compounds in value when:

- Many users ask overlapping questions (chatbot, search product)
- A user has multi-turn conversations referencing earlier context
- A long-running agent needs to recall what it did hours or days ago
- A tool monitors the same topics across multiple sessions (competitive intelligence, weekly briefings)

None of those apply here. For this boilerplate, `CLEAR_RAG_ON_START` is the one practical lever — persistent RAG across sessions is free with an env var change.

### When to implement

Implement episodic memory when moving to a domain-specific deployment where:

1. **The question space is bounded** — a customer support agent, a product FAQ bot, a domain researcher. Unbounded question spaces (any question about anything) have low cache hit rates.
2. **Repeated questions are likely** — same user returning, or many users in the same domain asking similar things.
3. **Freshness requirements are clear** — you can define confidently when an answer is "stale" (a restaurant list from 6 months ago is stale; a legal principle from 5 years ago may not be).
4. **The answer quality justifies caching** — only cache HIGH or MEDIUM confidence answers. LOW confidence answers should always trigger a fresh pipeline run.
