# claude-agentinc-rag

Deterministic multi-agent RAG pipeline built with the Claude Agent SDK, web research, indexed retrieval, and confidence-based synthesis.

This project is a small, code-controlled research system rather than a prompt-only orchestration demo. It runs a fixed pipeline:

1. `researcher` gathers evidence from the web
2. `indexer` writes that evidence into the RAG store
3. `synthesizer` answers from indexed knowledge only
4. the orchestrator decides whether to stop or run another targeted pass

It is designed to be a practical starting point for agentic research workflows where grounded answers, iterative coverage, and clean separations of responsibility matter.

## Why This Repo Exists

Most agent demos blur orchestration, retrieval, prompting, and output handling into one file. This repo takes the opposite approach:

- deterministic orchestration instead of free-form agent loops
- explicit RAG runtime bootstrap instead of import-time side effects
- retrieval-backed synthesis instead of direct web-to-answer generation
- confidence-based retry logic instead of a single pass with no coverage feedback
- modular orchestration code that is easier to extend and reason about

## What It Does

- runs a `researcher -> indexer -> synthesizer` pipeline
- gathers live web evidence with `WebSearch` and `WebFetch`
- stores evidence in a RAG backend exposed through an in-process MCP server
- synthesizes answers only from indexed knowledge
- emits a machine-readable confidence block to drive retry decisions
- supports configurable web budgets, retry depth, and per-agent model selection

## Architecture at a Glance

```text
Question
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
  +--> indexer     -> index_document + list_indexed
  +--> synthesizer -> search_documents -> cited answer + confidence JSON
  |
  +--> low confidence    -> targeted retry
  +--> medium/high       -> stop
```

Current default behavior:

- default mode stops on `medium` or `high`
- deep research mode retries on `medium` and `low`
- the synthesizer answers only from indexed knowledge
- the active store is Neon pgvector with local embeddings

## Quick Start

### Prerequisites

- Node.js 20+
- an `ANTHROPIC_API_KEY`
- a `DATABASE_URL` for Neon Postgres with pgvector support

### Setup

```bash
git clone <repo>
cd claude-agentinc-rag
npm install
cp .env.example .env
```

Set these environment variables in `.env`:

```bash
ANTHROPIC_API_KEY=...
DATABASE_URL=...
```

Run a question:

```bash
npm run ask "can you tell me the top five places to visit in hobart"
```

Build the project:

```bash
npm run build
```

## How the Pieces Fit Together

### Core runtime

- `src/index.ts`: CLI entry point and startup flow
- `src/rag/index.ts`: explicit runtime bootstrap returning `{ ragStore, ragServer }`
- `src/orchestrator/index.ts`: session loop and retry flow

### Orchestration modules

- `src/orchestrator/agentRunner.ts`: Claude SDK execution per agent
- `src/orchestrator/planner.ts`: query planning and stop policy
- `src/orchestrator/presenter.ts`: terminal rendering and progress output
- `src/orchestrator/researchOutput.ts`: SOURCE parsing and URL dedupe
- `src/orchestrator/limiter.ts`: web tool budgets
- `src/orchestrator/config.ts`: env-backed configuration

### Agents

- `src/agents/researcher.ts`: gathers evidence from the web
- `src/agents/indexer.ts`: turns SOURCE blocks into indexed documents
- `src/agents/synthesizer.ts`: answers using retrieved documents only

## Customizing for a New Domain

For most use cases, these are the main files you will change.

### `src/agents/researcher.ts`

Use this to change where evidence comes from and how it should be extracted.

Examples:
- jobs: job boards, careers pages, recruiter sources
- legal: legislation, courts, regulators
- ecommerce: retailer pages, marketplace listings, pricing sources
- internal systems: replace web tools with MCP tools for your own data

### `src/agents/synthesizer.ts`

Use this to change answer structure and confidence rules.

Examples:
- research brief: findings, evidence, open questions
- events: name, date, location, venue certainty
- support assistant: probable cause, remediation, verification steps
- market scan: vendor summary, comparison, risks, gaps

### `src/agents/indexer.ts`

Change this if you change the source format. If your researcher no longer emits `SOURCE` blocks, the indexer prompt should evolve with it.

### `src/rag/index.ts`

Change this when you want to swap the active store implementation.

Available directions already present in the repo:

- Neon pgvector
- MiniSearch BM25
- in-memory vector store

### `src/orchestrator/toolConfig.ts`

Change this when your environment injects tools you do not want in agent context, or when you add new MCP-backed capabilities.

## Configuration

Important environment variables:

| Variable | Purpose |
|---|---|
| `DEEP_RESEARCH` | Retry on `medium` confidence as well as `low` |
| `MAX_RESEARCH_ITERATIONS` | Hard cap on loop count |
| `CLEAR_RAG_ON_START` | Reset indexed state at the beginning of a session |
| `INITIAL_WEB_FETCHES` | First-pass fetch budget |
| `GAP_WEB_FETCHES` | Later-pass fetch budget |
| `INITIAL_WEB_SEARCHES` | First-pass search budget |
| `GAP_WEB_SEARCHES` | Later-pass search budget |
| `RESEARCHER_MODEL` | Research agent model override |
| `INDEXER_MODEL` | Indexer model override |
| `SYNTHESIZER_MODEL` | Synthesizer model override |
| `ANTHROPIC_API_KEY` | Claude API access |
| `DATABASE_URL` | Neon/Postgres connection string |

Practical guidance:

- keep default mode for lower-cost runs
- enable `DEEP_RESEARCH=true` when recall matters more than cost
- increase first-pass budgets for noisy domains
- keep gap-fill budgets smaller so retries stay focused

## Good Fit Use Cases

This repo is a strong fit when:

- answers should be grounded in gathered evidence
- coverage gaps should be made explicit
- information changes over time
- retrieval should sit between research and synthesis
- you want a reusable agentic research boilerplate, not a one-off prompt demo

Examples:

- event discovery and aggregation
- travel research assistants
- market and competitor scans
- policy and regulation monitoring
- procurement and vendor comparison workflows
- internal knowledge enrichment pipelines

## When This Is Not the Right Tool

This is probably overkill when:

- you only need a single direct answer with no retrieval layer
- all trustworthy data already lives in an internal system
- deterministic business rules matter more than research breadth
- your workflow is transactional rather than investigative

In those cases, a simpler tool-calling agent or a non-agent pipeline may be a better fit.

## Related Docs

- `ARCHITECTURE.md` for the detailed system design
- `BOILERPLATE.md` for extension and reuse guidance
