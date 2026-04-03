# Architecture: claude-agentinc-rag

Agentic RAG + ReAct multi-agent orchestration demo using the Claude Agent SDK.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Component Map](#component-map)
3. [Data Flow](#data-flow)
4. [ReAct Loop](#react-loop)
5. [Agent Definitions](#agent-definitions)
6. [RAG Server](#rag-server)
7. [Model Strategy](#model-strategy)
8. [Key Architectural Decisions](#key-architectural-decisions)

---

## System Overview

The system answers open-ended research questions by orchestrating three specialist AI agents in a **ReAct (Reason-Act-Observe)** loop. Web content is fetched, indexed into an in-memory BM25 store, and then retrieved to compose a cited answer. The loop runs up to 3 iterations, with each iteration targeting knowledge gaps reported by the synthesizer.

```
             ┌──────────────────────────────────────┐
             │            User (CLI)                │
             │   npm run ask "research question"    │
             └────────────────┬─────────────────────┘
                              │
                              ▼
             ┌──────────────────────────────────────┐
             │           src/index.ts               │
             │  - reads process.argv                │
             │  - validates ANTHROPIC_API_KEY        │
             │  - calls runResearchSession()         │
             └────────────────┬─────────────────────┘
                              │
                              ▼
             ┌──────────────────────────────────────┐
             │         src/orchestrator.ts          │
             │  claude-sonnet-4-6 + ReAct prompt    │
             │  Only tool: Agent (spawns subagents) │
             │  Max 30 turns, up to 3 ReAct loops   │
             └──────────────────────────────────────┘
```

---

## Component Map

```
claude-agentinc-rag/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── orchestrator.ts       # ReAct orchestrator (sonnet-4-6)
│   ├── rag-server.ts         # In-process MCP server (MiniSearch/BM25)
│   ├── renderer.ts           # Terminal output formatting
│   ├── types.ts              # Shared TypeScript types
│   └── agents/
│       ├── researcher.ts     # Web search + fetch agent (haiku)
│       ├── indexer.ts        # RAG ingestion agent (haiku)
│       └── synthesizer.ts    # Answer composition agent (haiku)
└── package.json              # Claude Agent SDK, MiniSearch, Zod
```

### Dependency graph

```
index.ts
  └── orchestrator.ts
        ├── agents/researcher.ts   (AgentDefinition)
        ├── agents/indexer.ts      (AgentDefinition + rag MCP)
        ├── agents/synthesizer.ts  (AgentDefinition + rag MCP)
        ├── rag-server.ts          (MCP server singleton)
        └── renderer.ts
```

---

## Data Flow

```
User Query
    │
    ▼
┌────────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR  (ReAct loop, max 3 iterations)                  │
│                                                                │
│  ┌─── ITERATION N ──────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  THINK: What do I need to find?                          │  │
│  │    │                                                     │  │
│  │    ▼                                                     │  │
│  │  ACT 1 ── researcher ────────────────────────────────┐  │  │
│  │           { queries, context,                        │  │  │
│  │             isGapFilling, previouslyCovered }        │  │  │
│  │                │                                     │  │  │
│  │                │  WebSearch (3-5 URLs/query)         │  │  │
│  │                │  WebFetch  (top 2-3 URLs/query)     │  │  │
│  │                │                                     │  │  │
│  │                ▼                                     │  │  │
│  │           SOURCE blocks ◄────────────────────────────┘  │  │
│  │    │                                                     │  │
│  │    ▼                                                     │  │
│  │  ACT 2 ── indexer ───────────────────────────────────┐  │  │
│  │           receives SOURCE blocks                     │  │  │
│  │                │                                     │  │  │
│  │                │  index_document (per source)        │  │  │
│  │                │  list_indexed   (confirm)           │  │  │
│  │                │        │                            │  │  │
│  │                │        ▼                            │  │  │
│  │                │   ┌─────────────────────┐           │  │  │
│  │                │   │  RAG MCP Server     │           │  │  │
│  │                │   │  (MiniSearch BM25)  │           │  │  │
│  │                │   │  in-process memory  │           │  │  │
│  │                │   └─────────────────────┘           │  │  │
│  │                ▼                                     │  │  │
│  │           INDEXED: N docs ◄──────────────────────────┘  │  │
│  │    │                                                     │  │
│  │    ▼                                                     │  │
│  │  ACT 3 ── synthesizer ───────────────────────────────┐  │  │
│  │           question (iter 1)                          │  │  │
│  │           "KNOWN GAPS: [...]\n\nQuestion: ..." (2+)  │  │  │
│  │                │                                     │  │  │
│  │                │  search_documents (3-5 calls,       │  │  │
│  │                │    query rewriting if score < 0.3)  │  │  │
│  │                │        │                            │  │  │
│  │                │        ▼                            │  │  │
│  │                │   ┌─────────────────────┐           │  │  │
│  │                │   │  RAG MCP Server     │           │  │  │
│  │                │   │  BM25 ranked results│           │  │  │
│  │                │   └─────────────────────┘           │  │  │
│  │                ▼                                     │  │  │
│  │           Cited answer + JSON confidence block ◄─────┘  │  │
│  │    │                                                     │  │
│  │    ▼                                                     │  │
│  │  OBSERVE: parse { confidence, missingTopics,            │  │
│  │                   coverageNotes }                        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
    │
    ▼
Final Answer (rendered to terminal)
```

---

## ReAct Loop

The loop logic is entirely prompt-driven — no code implements the branching. The orchestrator's system prompt defines the decision table:

```
After each OBSERVE:

  confidence == "high"
      └── Present answer → STOP

  confidence == "medium" AND iteration >= 2
      └── Present answer + coverage note → STOP

  confidence == "low" AND iteration < 3
      └── Extract missingTopics
          Build gap-filling queries
          → START NEXT ITERATION

  iteration == 3 (regardless of confidence)
      └── Present best available answer + disclaimer → STOP
```

### Iteration shape

```
Iteration 1 (broad)                Iteration 2+ (gap-filling)
─────────────────────              ──────────────────────────
queries:  2-3 broad aspects        queries:  missingTopics from prev
context:  original question        context:  "gap filling for: [Q]"
isGapFilling: false                isGapFilling: true
previouslyCovered: []              previouslyCovered: [urls fetched]
```

---

## Agent Definitions

All three specialist agents are defined as `AgentDefinition` objects and registered on the orchestrator's `query()` call. The orchestrator calls them via the `Agent` tool — it has no other tools.

### Researcher

```
Model:  claude-haiku-4-5
Tools:  WebSearch, WebFetch
MCP:    none

Input:  JSON task object
        { queries[], context, isGapFilling, previouslyCovered[] }

Output: one SOURCE block per fetched page
        ---
        SOURCE:    <url>
        TITLE:     <title>
        RELEVANCE: <1-2 sentences>
        CONTENT:   <up to ~800 words, boilerplate stripped>
        ---
        RESEARCH SUMMARY: Fetched N sources covering: [topics]

Gap-fill behaviour:
  - tries 2+ search phrasings per missing topic
  - accepts narrower sources if they directly address the gap
  - explicitly notes topics with no web coverage
  - skips URLs in previouslyCovered
```

### Indexer

```
Model:  claude-haiku-4-5
Tools:  (none — uses MCP only)
MCP:    rag (index_document, list_indexed)

Input:  full researcher output (SOURCE blocks)

Process:
  for each SOURCE block:
    → index_document(content, url, title, relevance_note)
  → list_indexed (confirm state)

Output: INDEXED: N documents
        TITLES: [list]
        KNOWLEDGE BASE TOTAL: X documents
```

### Synthesizer

```
Model:  claude-haiku-4-5
Tools:  (none — uses MCP only)
MCP:    rag (search_documents)

Input:  question                          (iteration 1)
        "KNOWN GAPS: [...]\n\nQ: ..."     (iteration 2+)

Iterative search protocol:
  THINK:   identify 3-4 angles of the question
  for each angle:
    ACT:     search_documents(query, max_results=5)
    OBSERVE: check relevance scores
    if scores mostly < 0.3:
      ACT:   search_documents(rewritten_query)  ← query rewriting

Query rewriting rules:
  all scores < 0.3       → sub-terms, synonyms
  off-topic results      → completely different framing
  right domain, wrong    → add qualifiers

Output: cited answer using [source: Title] or [source: URL]
        + REQUIRED trailing JSON block:
        ```json
        {
          "confidence": "high" | "medium" | "low",
          "missingTopics": [],
          "coverageNotes": "..."
        }
        ```

Confidence thresholds:
  high:   multiple results score > 0.5, multi-angle coverage
  medium: some direct evidence, gaps present, or lower scores
  low:    sparse results, low scores, major aspects unaddressed
```

---

## RAG Server

```
File:      src/rag-server.ts
Transport: in-process (no subprocess, no IPC)
Library:   MiniSearch (BM25 full-text search)
Scope:     ephemeral — memory lives for one runResearchSession() call

Exposed MCP tools:
┌─────────────────┬──────────────────────────────────────────────────┐
│ Tool            │ Description                                      │
├─────────────────┼──────────────────────────────────────────────────┤
│ index_document  │ Add doc to MiniSearch; stores in docRegistry map │
│ search_documents│ BM25 search; title boosted 2x; fuzzy 0.2;       │
│                 │ returns ranked { rank, score, title, url,        │
│                 │ excerpt (400 chars) }                            │
│ list_indexed    │ Enumerate docRegistry (no search needed)         │
│ clear_index     │ miniSearch.removeAll() + reset docCount          │
└─────────────────┴──────────────────────────────────────────────────┘

MiniSearch config:
  fields:       ['title', 'content']   ← indexed for search
  storeFields:  ['title', 'url', 'content']  ← returned in results
  search boost: title × 2
  fuzzy:        0.2 (allows minor typos)
```

### RAG server access pattern

```
Indexer agent                    Synthesizer agent
─────────────────                ─────────────────────────────
index_document ──► MiniSearch    search_documents ──► MiniSearch
list_indexed   ──► docRegistry               ▲
                                             │
                              iterative query rewriting loop
```

The RAG server is registered once on the orchestrator's `query()` call and shared across both indexer and synthesizer via the `mcpServers: ['rag']` field in each `AgentDefinition`.

---

## Model Strategy

| Component    | Model              | Rationale                                              |
|--------------|--------------------|--------------------------------------------------------|
| Orchestrator | claude-sonnet-4-6  | Needs strong reasoning for ReAct loop control and gap analysis |
| Researcher   | claude-haiku-4-5   | Simple I/O: parse task JSON, call two tools, format output |
| Indexer      | claude-haiku-4-5   | Mechanical: parse SOURCE blocks, call index_document for each |
| Synthesizer  | claude-haiku-4-5   | Heavier reasoning (query rewriting, answer composition) but cost-sensitive; haiku with a detailed prompt is sufficient |

The orchestrator uses `thinking: { type: 'adaptive' }`, enabling extended thinking on complex queries without paying the cost on every turn.

---

## Key Architectural Decisions

### 1. Orchestrator-only ReAct, subagents as pure actions

The ReAct loop (THINK → ACT → OBSERVE) lives entirely in the orchestrator's system prompt. Subagents are stateless workers — they receive input, do one job, return output. This keeps each agent simple and testable in isolation, and concentrates loop logic in one place.

### 2. Confidence JSON as the only cross-agent channel

The synthesizer always ends with a structured JSON block. This is the only reliable way to pass machine-readable state back to the orchestrator across a subagent boundary. Plain text would require brittle regex; a trailing JSON block after human-readable prose is unambiguous to parse.

### 3. In-process MCP server (no subprocess)

The RAG server runs in the same Node.js process as the orchestrator via `createSdkMcpServer`. No socket, no subprocess, no serialization overhead. The MiniSearch index is a plain JS object in memory. Trade-off: the index is lost when the process exits, but for a single-session research tool this is acceptable and dramatically simpler than standing up a persistent store.

### 4. BM25 over vector embeddings

MiniSearch uses BM25 (term frequency + inverse document frequency), not semantic vector search. This means:
- No embedding model calls, no latency, no cost
- Works well when the synthesizer uses terms that appear in source text
- Mitigated by the synthesizer's query rewriting loop (synonyms, sub-terms, different framing when scores are low)
- Limitation: cannot match semantically similar but lexically different content

### 5. Haiku for all subagents

All three subagents use `claude-haiku-4-5`. Their tasks are well-scoped and guided by detailed prompts, so the cheaper model suffices. Sonnet is reserved for the orchestrator, which must reason about gaps, compose multi-iteration strategy, and parse confidence signals. This keeps per-query cost low while maintaining quality where it matters.

### 6. Gap-filling with `previouslyCovered` deduplication

On iteration 2+, the orchestrator passes the list of already-fetched URLs to the researcher. This prevents re-fetching the same pages and forces the researcher to find new sources for missing topics. Without this, gap-filling iterations would often re-index the same content and make no progress.

### 7. Max 3 iterations / max 30 turns

The `maxTurns: 30` cap on the orchestrator session prevents runaway loops. The ReAct protocol caps at 3 iterations by prompt instruction. At iteration 3 the synthesizer presents its best answer regardless of confidence — this ensures the system always terminates with *some* answer rather than failing silently.

### 8. Separation of indexing and retrieval agents

The indexer and synthesizer are separate agents rather than one combined agent. This prevents the synthesizer from being distracted by raw SOURCE blocks during answer composition, and keeps each agent's context window focused. The shared RAG MCP server is the only coupling between them.

### 9. Source excerpt truncation (400 chars)

`search_documents` returns only the first 400 characters of each document as an excerpt. Full documents are stored in MiniSearch but not returned verbatim. This keeps the synthesizer's context window manageable when many results are returned across multiple search calls.

### 10. `permissionMode: 'bypassPermissions'`

The orchestrator runs with `permissionMode: 'bypassPermissions'` so subagents can call WebSearch, WebFetch, and MCP tools without interactive approval prompts. This is appropriate for a CLI research tool where the user's intent is already expressed via the question. A production deployment would want a more restrictive permission model.
