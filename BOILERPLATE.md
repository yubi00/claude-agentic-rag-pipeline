# Using This as a Boilerplate

This repository is a boilerplate for building agentic research systems with:

- deterministic multi-agent orchestration
- explicit RAG runtime bootstrap
- web evidence gathering
- indexed retrieval-backed synthesis
- configurable retry depth and web budgets

It is no longer a prompt-only orchestrator demo. The current design is a small code-controlled research pipeline that you can adapt by swapping prompts, tools, models, and the backing RAG store.

---

## Quick Start

```bash
git clone <repo>
cd claude-agentinc-rag
npm install
cp .env.example .env
# Add ANTHROPIC_API_KEY and DATABASE_URL
npm run ask "your research question"
```

---

## Architecture at a Glance

```text
User Query
  |
  v
initializeRagRuntime()
  |
  +--> ragStore
  +--> ragServer
  |
  v
runResearchSession(question, runtime)
  |
  +--> researcher  -> WebSearch + WebFetch -> SOURCE blocks
  +--> indexer     -> index_document/list_indexed
  +--> synthesizer -> search_documents -> cited answer + confidence JSON
  |
  +--> low confidence    -> targeted retry
  +--> medium/high       -> return answer
```

---

## What You Keep

These parts are reusable infrastructure and usually stay intact:

- `src/orchestrator/index.ts`
- `src/orchestrator/agentRunner.ts`
- `src/orchestrator/planner.ts`
- `src/orchestrator/presenter.ts`
- `src/orchestrator/researchOutput.ts`
- `src/orchestrator/limiter.ts`
- `src/rag/server.ts`
- `src/rag/tools/*`

---

## What You Usually Change

### 1. `src/agents/researcher.ts`

Change this when you want different evidence sources, structured extraction rules, or domain-specific search behavior.

Examples:
- jobs: job boards, company careers pages, LinkedIn alternatives
- legal: legislation, case law, regulator sources
- ecommerce: retailer product pages, marketplace listings, pricing pages
- internal enterprise: replace web tools with custom MCP tools for your own systems

### 2. `src/agents/synthesizer.ts`

Change this when you want a different answer structure or different confidence standards.

Examples:
- property analysis: address, price, comps, confidence
- research brief: findings, evidence, open questions
- events: name, date, location, venue certainty
- support assistant: diagnosis, probable cause, remediation, verification steps

### 3. `src/agents/indexer.ts`

Change this only if your source format changes. If you replace `SOURCE` blocks with a different structured format, update the indexer prompt accordingly.

### 4. `src/rag/index.ts`

Change this when you want to switch the active store implementation.

Current default:
- Neon pgvector with local embeddings

Possible alternatives already in the repo:
- MiniSearch BM25
- in-memory vector store

### 5. `src/orchestrator/toolConfig.ts`

Change this when you add or remove tools or MCP servers.

### 6. `src/libs/agentFormatters.ts`

Change this when you add new agents or want different terminal summaries.

---

## Core Extension Points

### Add a new agent

1. Create a new `src/agents/<name>.ts` file
2. Extend orchestration flow if the new step is part of the core pipeline
3. Add formatting in `src/libs/agentFormatters.ts` if needed
4. Add any required tools in `src/orchestrator/toolConfig.ts`

### Replace the RAG backend

Keep the `IRagStore` contract and the MCP tool surface stable.

If the new store still supports:
- `addDocument`
- `searchDocuments`
- `listDocuments`
- `clearDocuments`

then the rest of the application can remain unchanged.

### Change retry behavior

The retry policy is controlled in `src/orchestrator/planner.ts` and `src/orchestrator/index.ts`.

Current default:
- stop on `medium` or `high`
- retry only on `low`

Optional deeper mode:
- set `DEEP_RESEARCH=true`

---

## Cost and Quality Controls

Key env settings:

| Setting | Purpose |
|---|---|
| `DEEP_RESEARCH` | Retry on medium confidence as well as low |
| `MAX_RESEARCH_ITERATIONS` | Hard cap on loop count |
| `INITIAL_WEB_FETCHES` | Broader first-pass fetch budget |
| `GAP_WEB_FETCHES` | Focused later-pass fetch budget |
| `INITIAL_WEB_SEARCHES` | First-pass search budget |
| `GAP_WEB_SEARCHES` | Later-pass search budget |
| `RESEARCHER_MODEL` | Research agent model override |
| `INDEXER_MODEL` | Indexer model override |
| `SYNTHESIZER_MODEL` | Synthesizer model override |

Practical guidance:

- Keep default mode for generic, cheaper boilerplate behavior.
- Turn on `DEEP_RESEARCH` for higher recall and more retries.
- Increase first-pass budgets for messy domains with weak sources.
- Keep later-pass budgets smaller so retries stay focused.

---

## Good Fit Use Cases

This boilerplate fits domains where:

- evidence must be gathered before answering
- sources change over time
- confidence and coverage matter
- retrieval should sit between research and synthesis

Examples:
- event discovery and aggregation
- travel research assistants
- market and competitor scans
- policy and regulation tracking
- procurement/vendor comparison tools
- internal knowledge enrichment pipelines

---

## Less Suitable Use Cases

This is a weaker fit when:

- you only need a single direct answer with no retrieval layer
- all data already exists in a trusted internal database
- deterministic business rules matter more than research breadth
- you need transactional workflows instead of evidence gathering

In those cases, a simpler tool-calling agent or a non-agent workflow may be a better starting point.
