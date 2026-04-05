# Architecture: claude-agentinc-rag

Agentic RAG research pipeline with a provider-agnostic agent runner interface.

The current architecture is code-controlled, not prompt-controlled. The runtime executes a deterministic sequence:

1. `researcher` gathers web evidence
2. orchestrator parses SOURCE blocks and writes directly to the RAG store (no LLM)
3. `synthesizer` answers from indexed knowledge only
4. the orchestrator parses confidence and decides whether to stop or run another research pass

---

## Runner implementations

The pipeline is provider-agnostic. The orchestrator only sees `IAgentRunner` — it has no knowledge of which SDK or model is in use.

| Runner | SDK | Models | Doc |
|--------|-----|--------|-----|
| `ClaudeAgentRunner` | Claude Agent SDK | Claude (Haiku, Sonnet, Opus) | [docs/runner-claude.md](docs/runner-claude.md) |
| `VercelAgentRunner` | Vercel AI SDK | Gemini via `@ai-sdk/google` | [docs/runner-vercel.md](docs/runner-vercel.md) |
| `LangChainRunner` | LangChain.js | Any (OpenAI, Gemini, Mistral…) | [docs/runner-langchain.md](docs/runner-langchain.md) |

Adding a new runner means implementing `IAgentRunner` only — the orchestrator, RAG store, and agent prompts are unchanged.

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

---

## System Overview

The CLI bootstraps a RAG runtime explicitly at startup, then passes that runtime into the orchestrator. The orchestrator owns only session flow and iteration policy; agent execution, planning, output rendering, and research-output processing live in smaller modules.

```text
User
  |
  v
src/index.ts
  - reads CLI question
  - validates env
  - calls initializeRagRuntime()
  - constructs IAgentRunner (ClaudeAgentRunner or VercelAgentRunner)
  - calls runResearchSession(question, runtime, runner)
  |
  v
src/rag/index.ts
  - creates active store
  - initializes store
  - creates in-process MCP server
  - returns { ragStore, ragServer }
  |
  v
src/orchestrator/index.ts
  - runs deterministic iteration loop
  - researcher -> index (code) -> synthesizer
  - parses confidence
  - retries only when policy says to retry
```

---

## Component Map

```text
claude-agentinc-rag/
├── src/
│   ├── index.ts                    # CLI entry point
│   ├── agents/
│   │   ├── researcher.ts           # Web evidence gathering prompt
│   │   └── synthesizer.ts          # Retrieval + answer prompt
│   ├── orchestrator/
│   │   ├── index.ts                # Session loop
│   │   ├── runner/
│   │   │   ├── interface.ts        # IAgentRunner contract
│   │   │   ├── claudeAgentRunner.ts # Claude Agent SDK implementation
│   │   │   ├── vercelAgentRunner.ts # Vercel AI SDK + Gemini implementation
│   │   │   ├── vercelTools.ts      # Tool set wiring (researcher + synthesizer)
│   │   │   └── tools/
│   │   │       ├── webSearchTool.ts      # Vercel WebSearch tool
│   │   │       ├── webFetchTool.ts       # Vercel WebFetch tool
│   │   │       └── searchDocumentsTool.ts # Vercel search_documents tool
│   │   ├── planner.ts              # Query planning and stop policy
│   │   ├── presenter.ts            # Terminal rendering
│   │   ├── researchOutput.ts       # SOURCE parsing, dedupe, and RAG indexing
│   │   ├── config.ts               # env-backed config
│   │   ├── limiter.ts              # Web tool budgets (Claude runner only)
│   │   ├── toolConfig.ts           # tool allow/deny lists (Claude runner only)
│   │   └── types.ts                # orchestrator shared types
│   ├── rag/
│   │   ├── index.ts                # explicit RAG runtime bootstrap
│   │   ├── server.ts               # in-process MCP server factory
│   │   ├── neon-store.ts           # active pgvector-backed store
│   │   ├── minisearch-store.ts     # alternative in-process store
│   │   ├── vector-store.ts         # alternative in-memory vector store
│   │   └── tools/                  # MCP tool implementations
│   ├── tools/
│   │   └── webTools.ts             # SDK-agnostic: tavilySearch, jinaFetch (shared across runners)
│   ├── libs/
│   │   ├── agentFormatters.ts      # agent-specific text formatting
│   │   ├── ansi.ts                 # color helpers
│   │   └── logger.ts               # pino logger
│   └── utils/
│       └── index.ts                # confidence parsing and text helpers
└── package.json
```

### Dependency graph

```text
index.ts
  ├── rag/index.ts
  |     ├── rag/neon-store.ts
  |     └── rag/server.ts
  |
  └── orchestrator/index.ts
        ├── orchestrator/runner/interface.ts
        ├── orchestrator/runner/claudeAgentRunner.ts
        ├── orchestrator/runner/vercelAgentRunner.ts
        ├── orchestrator/planner.ts
        ├── orchestrator/presenter.ts
        ├── orchestrator/researchOutput.ts  (includes indexResearchOutput)
        └── agents/{researcher,synthesizer}.ts
```

---

## Data Flow

```text
Question
  |
  v
initializeRagRuntime()
  |
  +--> ragStore  (active store implementation)
  +--> ragServer (MCP server backed by ragStore)
  |
  v
runResearchSession(question, runtime)
  |
  +--> optional clearDocuments()
  |
  +--> iteration 1..N
         |
         +--> build research task
         +--> run researcher
         |      - WebSearch
         |      - WebFetch
         |      - emits SOURCE blocks
         |
         +--> dedupe SOURCE blocks against previously covered URLs
         |
         +--> if no new SOURCE blocks:
         |      - mark confidence low
         |      - retry or stop
         |
         +--> indexResearchOutput() [code, no LLM]
         |      - parseSourceBlocks()
         |      - ragStore.addDocument() per source
         |
         +--> run synthesizer
         |      - search_documents
         |      - cited answer
         |      - trailing JSON confidence block
         |
         +--> parse confidence
         +--> stop or gap-fill
```

---

## Iteration Control

Iteration control is implemented in code in `src/orchestrator/index.ts`, not delegated to a free-form orchestrator prompt.

### Stop policy

Default mode:

```text
high   -> stop
medium -> stop
low    -> retry until max iterations
```

Deep research mode:

```text
high         -> stop
medium / low -> retry until max iterations
```

### Research passes

Iteration 1:
- broad initial queries
- higher fetch/search budget

Iteration 2+:
- targeted gap-filling queries derived from `missingTopics`
- smaller fetch/search budget
- dedupe against previously covered URLs

### No-source guard

If the researcher returns no new indexable `SOURCE` blocks after deduplication, the orchestrator skips indexing and synthesis for that pass and treats the iteration as low-confidence gap-filling input.

---

## Agent Definitions

### Researcher

File: `src/agents/researcher.ts`

- Tools: `WebSearch`, `WebFetch`
- Responsibility: gather external evidence and emit structured `SOURCE` blocks
- Input: JSON task object with queries, context, gap-filling flag, previously covered URLs, and fetch budget
- Output: source blocks plus `RESEARCH SUMMARY`

Important behavior:
- enforces total fetch budget per task
- preserves high-value unfetched search results when needed
- emits event-specific `SOURCE` blocks for event-style queries when possible
- avoids mentioning facts in summary that are not present in a `SOURCE` block

### Synthesizer

File: `src/agents/synthesizer.ts`

- Tools: MCP `rag` search only
- Responsibility: answer only from indexed knowledge
- Input: original question or `KNOWN GAPS: ...` prompt
- Output: cited answer plus required trailing confidence JSON block

Important behavior:
- performs multiple retrieval angles
- rewrites queries if retrieval quality is weak
- uses stricter confidence rules for time-sensitive queries
- distinguishes confirmed event venue from city-level location and organizer/contact address

---

## RAG Runtime

The active backend is Neon Postgres with pgvector.

### Bootstrap

File: `src/rag/index.ts`

```text
initializeRagRuntime()
  - validate DATABASE_URL
  - create embedder
  - create NeonVectorStore
  - initialize store
  - create in-process MCP server
  - return { ragStore, ragServer }
```

### Active store

File: `src/rag/neon-store.ts`

- persistent pgvector-backed semantic retrieval
- local embeddings
- chunk-based document indexing
- `clearDocuments`, `addDocument`, `searchDocuments`, `listDocuments`

### MCP server

File: `src/rag/server.ts`

Exposed tools:
- `index_document`
- `search_documents`
- `list_indexed`
- `clear_index`

The MCP server is created once per runtime and passed into subagents that need it.

---

## Key Configuration

Primary session controls:

- `DEEP_RESEARCH`
- `MAX_RESEARCH_ITERATIONS`
- `CLEAR_RAG_ON_START`
- `INITIAL_WEB_FETCHES`
- `GAP_WEB_FETCHES`
- `INITIAL_WEB_SEARCHES`
- `GAP_WEB_SEARCHES`

Provider controls:

- `AGENT_PROVIDER` — `claude` (default) or `vercel`

Claude provider:
- `AGENT_MODEL` / `RESEARCHER_MODEL` / `SYNTHESIZER_MODEL`
- `ANTHROPIC_API_KEY`

Vercel/Gemini provider:
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `TAVILY_API_KEY`

Infrastructure:

- `DATABASE_URL`
- `LOG_LEVEL`

---

## Key Architectural Decisions

### 1. Deterministic orchestration

The pipeline order is enforced in code, not left to model discretion. This reduces ambiguity and makes failures easier to diagnose.

### 2. Explicit runtime bootstrap

RAG initialization no longer happens at import time. Startup builds a runtime explicitly and injects it into the orchestrator.

### 3. Small orchestration modules

The original monolithic orchestration file was split into runner, planner, presenter, config, and research-output helpers. This keeps responsibilities narrower and easier to test.

### 4. Retrieval-only synthesis

The synthesizer answers only from indexed knowledge, never directly from the web. This preserves the separation between evidence gathering and answer generation.

### 5. Source-preserving research

The researcher is optimized to preserve indexable evidence, not just produce a narrative summary. This matters especially for event-like and time-sensitive queries.

### 6. Configurable cost controls

Fetch/search budgets and iteration depth are env-driven so the same architecture can run as a cheap boilerplate or a more thorough research mode.

### 7. Single output path

Terminal rendering now flows through `presenter.ts` only. Duplicate legacy renderer/logger paths were removed to avoid drift.

### 8. Code-based indexing, no indexer agent

RAG ingestion is handled by `indexResearchOutput()` in `researchOutput.ts`, not a subagent. The researcher emits structured `SOURCE` blocks; parsing and storing them is mechanical and needs no model judgment. This removes one LLM call per iteration with no loss of capability. Indexing progress is captured via structured logs (`doc.indexed` per document, `indexer.done` per iteration).

### 9. Provider-agnostic agent runner

Agent execution is abstracted behind `IAgentRunner` in `orchestrator/runner/interface.ts`. The orchestrator only calls `runner.run(agent, prompt, runtime, budget)` and receives `AgentRunResult` — it has no knowledge of which SDK or model is in use.

Two implementations ship out of the box:
- `ClaudeAgentRunner` — uses the Claude Agent SDK with native `WebSearch`/`WebFetch` tools and MCP server support
- `VercelAgentRunner` — uses Vercel AI SDK `ToolLoopAgent` with Gemini via `@ai-sdk/google`, Tavily for web search, and raw fetch for page content

The active runner is selected at startup via `AGENT_PROVIDER` env var and injected into `runResearchSession()`. Adding a new provider means implementing `IAgentRunner` only — the rest of the pipeline is unchanged.
