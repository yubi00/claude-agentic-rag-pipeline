# agentic-rag

Provider-agnostic multi-agent RAG pipeline — swap between Claude, Gemini, and OpenAI runners to compare agentic frameworks (Claude Agent SDK, Vercel AI SDK, LangChain, Strands) with deterministic orchestration, web research, and confidence-based synthesis.

---

## Why This Repo Exists

Most agent demos blur orchestration, retrieval, prompting, and output handling into one file. This repo takes the opposite approach:

- **Deterministic orchestration** — fixed `researcher → index → synthesizer` pipeline enforced in code, not left to model discretion
- **Provider-agnostic runners** — swap Claude, Gemini, or OpenAI behind a single `IAgentRunner` contract without touching the orchestrator
- **Code-based RAG indexing** — content is indexed directly inside tool functions, not extracted by the model (verbatim, cheaper, more reliable)
- **Confidence-driven retry** — synthesizer emits a JSON confidence block; orchestrator decides whether to loop with gap-filling queries
- **Framework comparison** — four runner implementations let you compare how Claude Agent SDK, Vercel AI SDK, LangChain, and Strands Agents handle the same agentic workload

## What It Does

- runs a `researcher → index → synthesizer` pipeline
- gathers live web evidence via Tavily (search) and Jina Reader (full-page fetch, JS-heavy pages)
- indexes content directly inside tool functions — model never sees raw page content
- synthesizes answers only from the indexed RAG knowledge base
- emits a machine-readable confidence block to drive retry decisions
- supports configurable web budgets, retry depth, and per-provider model selection

## Runners

Select the active runner with `AGENT_PROVIDER`:

| Provider | SDK | Model | Key features |
|----------|-----|-------|--------------|
| `claude` | Claude Agent SDK | Claude Haiku / Sonnet | Native tools, MCP, best instruction following |
| `vercel` | Vercel AI SDK | Gemini 2.5 Flash | Parallel tools, `stopWhen` budget stop, mutex |
| `langchain` | LangChain + LangGraph | Gemini 2.5 Flash | ReAct sequential loop, `createAgent` v1 |
| `strands` | Strands Agents (TS) | gpt-4o-mini | Model-driven stop, hook budget, clean metrics |

See `docs/runner-*.md` for architecture decisions per runner.

## Architecture at a Glance

```text
Question
  |
  v
initializeRagRuntime()          ← NeonVectorStore + local embedder + MCP server
  |
  v
runResearchSession(question, runtime, runner)
  |
  +--> iteration 1..MAX_ITERATIONS
         |
         +--> runner.run('researcher')
         |      WebSearch → tavilySearch() → index snippets
         |      WebFetch  → jinaFetch()   → index full page
         |      returns indexedCount
         |
         +--> if indexedCount == 0 → skip synthesizer, retry
         |
         +--> runner.run('synthesizer')
         |      search_documents → ragStore (vector search)
         |      returns answer + JSON confidence block
         |
         +--> HIGH/MEDIUM → stop
         +--> LOW         → retry with gap list
```

The orchestrator is plain TypeScript — no LangGraph state machine needed at the outer level. Each runner wraps its own internal loop (ReAct, ToolLoopAgent, Strands loop) behind `IAgentRunner`.

## Quick Start

### Prerequisites

- Node.js 20+
- Neon Postgres with pgvector (`DATABASE_URL`)
- Provider-specific API keys (see below)

### Setup

```bash
git clone <repo>
cd claude-agentinc-rag
npm install
cp .env.example .env
```

### Pick a provider

**Strands + OpenAI** (gpt-4o-mini, recommended for learning):
```bash
AGENT_PROVIDER=strands
OPENAI_API_KEY=...
TAVILY_API_KEY=...
DATABASE_URL=...
```

**Vercel + Gemini** (cheapest, free tier available):
```bash
AGENT_PROVIDER=vercel
GOOGLE_GENERATIVE_AI_API_KEY=...
TAVILY_API_KEY=...
DATABASE_URL=...
```

**LangChain + Gemini**:
```bash
AGENT_PROVIDER=langchain
GOOGLE_GENERATIVE_AI_API_KEY=...
TAVILY_API_KEY=...
DATABASE_URL=...
```

**Claude** (best quality, most expensive):
```bash
AGENT_PROVIDER=claude
ANTHROPIC_API_KEY=...
DATABASE_URL=...
```

### Run

```bash
npm run ask "what are the best hiking trails near Melbourne"
```

## How the Pieces Fit Together

### Core runtime

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point, runner selection |
| `src/config/env.ts` | Central env config — all `process.env` access here |
| `src/rag/index.ts` | RAG runtime bootstrap — embedder + store + MCP server |
| `src/orchestrator/index.ts` | Session loop and retry flow |

### Runners

| File | Runner |
|------|--------|
| `src/orchestrator/runner/interface.ts` | `IAgentRunner` contract |
| `src/orchestrator/runner/claudeAgentRunner.ts` | Claude Agent SDK |
| `src/orchestrator/runner/vercelAgentRunner.ts` | Vercel AI SDK + Gemini |
| `src/orchestrator/runner/langchainAgentRunner.ts` | LangChain + LangGraph |
| `src/orchestrator/runner/strandsAgentRunner.ts` | Strands Agents + OpenAI |

### Tools

| Path | Used by |
|------|---------|
| `src/tools/webTools.ts` | All runners — SDK-agnostic Tavily + Jina logic |
| `src/orchestrator/runner/tools/` | Vercel tool wrappers |
| `src/orchestrator/runner/tools/langchain/` | LangChain tool wrappers |
| `src/orchestrator/runner/tools/strands/` | Strands tool wrappers |

### Orchestration modules

| File | Purpose |
|------|---------|
| `src/orchestrator/planner.ts` | Research task builder and stop policy |
| `src/orchestrator/presenter.ts` | Terminal rendering |
| `src/orchestrator/researchOutput.ts` | SOURCE parsing, URL dedupe |
| `src/agents/researcher.ts` | Researcher system prompt |
| `src/agents/synthesizer.ts` | Synthesizer system prompt |

## Configuration

All env vars go through `src/config/env.ts`. `validateEnv()` runs at startup and throws clearly if provider-required keys are missing.

### Session controls

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_PROVIDER` | `vercel` | Active runner: `claude`, `vercel`, `langchain`, `strands` |
| `DEEP_RESEARCH` | `false` | Retry on `medium` confidence too |
| `MAX_RESEARCH_ITERATIONS` | `3` | Hard cap on loop count |
| `CLEAR_RAG_ON_START` | `true` | Wipe RAG store before each session |
| `INITIAL_WEB_FETCHES` | `5` | Fetch budget, iteration 1 |
| `GAP_WEB_FETCHES` | `3` | Fetch budget, iterations 2+ |
| `INITIAL_WEB_SEARCHES` | `5` | Search budget, iteration 1 |
| `GAP_WEB_SEARCHES` | `3` | Search budget, iterations 2+ |

### Provider keys

| Variable | Required by |
|----------|------------|
| `ANTHROPIC_API_KEY` | `claude` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `vercel`, `langchain` |
| `OPENAI_API_KEY` | `strands` |
| `TAVILY_API_KEY` | `vercel`, `langchain`, `strands` |
| `DATABASE_URL` | all providers |

### Model overrides

| Variable | Default | Provider |
|----------|---------|---------|
| `GEMINI_MODEL` | `gemini-2.5-flash` | vercel, langchain |
| `OPENAI_MODEL` | `gpt-4o-mini` | strands |
| `AGENT_MODEL` | `claude-haiku-4-5-20251001` | claude |
| `RESEARCHER_MODEL` | `AGENT_MODEL` | claude |
| `SYNTHESIZER_MODEL` | `AGENT_MODEL` | claude |

## Customising for a Domain

The main files to change for a domain-specific deployment:

**`src/agents/researcher.ts`** — change where evidence comes from and what to extract. Examples: job boards, legislation, product listings, internal MCP tools instead of web tools.

**`src/agents/synthesizer.ts`** — change answer structure and confidence rules. Examples: research brief, event listing, support resolution, market scan.

**`src/rag/index.ts`** — swap the active store. Three options already in the repo: Neon pgvector (default), in-memory vector store, MiniSearch BM25.

## Good Fit Use Cases

- event discovery and aggregation
- travel and local research assistants
- market and competitor scans
- policy and regulation monitoring
- procurement and vendor comparison
- internal knowledge enrichment pipelines

## When This Is Overkill

- single direct answer with no retrieval needed
- all trustworthy data already in an internal system
- deterministic business rules matter more than research breadth
- transactional workflow rather than investigative

## Related Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — detailed system design, all architectural decisions, prompt caching and memory analysis
- [`docs/runner-claude.md`](docs/runner-claude.md) — Claude runner architecture
- [`docs/runner-vercel.md`](docs/runner-vercel.md) — Vercel runner architecture
- [`docs/runner-langchain.md`](docs/runner-langchain.md) — LangChain runner architecture
- [`docs/runner-strands.md`](docs/runner-strands.md) — Strands runner architecture
