# Using This as a Boilerplate

This project is a production-ready boilerplate for building **agentic RAG pipelines** using the Claude Agent SDK. It implements a ReAct (Reason-Act-Observe) multi-agent loop with web research, BM25 indexing, and iterative gap-filling.

---

## Quick Start

```bash
git clone <repo>
cd claude-agentinc-rag
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
npm run ask "your research question"
```

---

## Architecture at a Glance

```
User Query
    │
    ▼
Orchestrator (ReAct loop, max 3 iterations)
    │
    ├── researcher  → WebSearch + WebFetch → SOURCE blocks
    ├── indexer     → index_document (BM25 via MiniSearch)
    └── synthesizer → search_documents → cited answer + confidence JSON
                           │
                    confidence == "low" → loop again with gap queries
                    confidence == "high/medium" → return answer
```

---

## What to Change for a New Domain

Only 5 files need to change. Everything else is infrastructure you keep as-is.

### 1. `src/agents/researcher.ts` — Search strategy

Define where the researcher looks and how it formats results.

```ts
// Change the search strategy section:
// - GOOD sources: list domain-specific authoritative sites
// - AVOID: sites that block scraping or require login
// - Adjust output format if your domain needs structured fields

export const researcherDef: AgentDefinition = {
  prompt: RESEARCHER_PROMPT,
  tools: ['WebSearch', 'WebFetch'],
  model: 'haiku',
}
```

**Examples by domain:**
- Real estate: `agfg → domain.com.au, realestate.com.au, rpdata.com`
- Legal: `caselaw.findlaw.com, legislation.gov.au`
- Medical: `pubmed.ncbi.nlm.nih.gov, uptodate.com`
- Recruiting: your internal resume DB (replace WebFetch with a custom MCP tool)

---

### 2. `src/agents/synthesizer.ts` — Answer format

Define how the final answer is structured and what confidence means for your domain.

```ts
// Change the "Composing the answer" section to match your output format:
// - Property report? Use structured fields: address, price, comps, rating
// - Legal brief? Use IRAC format: Issue, Rule, Analysis, Conclusion
// - Restaurant guide? Use a ranked list with ratings, address, cuisine

// Adjust confidence thresholds to match your domain's stakes:
// high:   safe to present to user without disclaimer
// medium: present with a "verify before acting" note
// low:    insufficient data, trigger another research iteration
```

---

### 3. `src/prompt.ts` — Orchestrator instructions

The ReAct loop structure stays the same. Update the agent descriptions and final output format.

```ts
// Update the agent descriptions to match your domain context:
// - researcher: "Searches MLS listings and property databases..."
// - synthesizer: "Produces a structured property comp report..."

// Update the Final output section to describe your expected answer format
```

---

### 4. `src/toolConfig.ts` — Tool access

Add or remove tools from `SESSION_TOOLS`. If you add custom MCP servers (e.g. a CRM connector, database tool), register them here.

```ts
export const SESSION_TOOLS = [
  'Agent',
  'WebSearch',
  'WebFetch',
  'mcp__rag__index_document',
  'mcp__rag__search_documents',
  'mcp__rag__list_indexed',
  'mcp__rag__clear_index',
  'mcp__your_custom_tool__query',  // ← add your tools here
]
```

Update `DISALLOWED_TOOLS` to match your Claude Code environment's MCP servers.

---

### 5. `src/agentFormatters.ts` — Terminal output

Add a formatter for any new agent you register. Existing formatters for researcher/indexer/synthesizer can be customised to extract domain-specific fields from agent output.

```ts
export const AGENT_FORMATTERS: Record<string, (text: string) => void> = {
  researcher:  formatResearcher,
  indexer:     formatIndexer,
  synthesizer: formatSynthesizer,
  // add: myNewAgent: formatMyNewAgent,
}
```

---

## Tuning Cost vs Quality

| Setting | File | Default | Notes |
|---|---|---|---|
| Orchestrator model | `.env` | haiku | Set `ORCHESTRATOR_MODEL=claude-sonnet-4-6` for complex queries |
| WebFetch cap | `src/limiter.ts` | 4 | Lower to 2 for cheaper runs, raise to 8 for thoroughness |
| WebSearch cap | `src/limiter.ts` | 4 | Same trade-off |
| Max iterations | `src/orchestrator.ts` | 15 turns | Lower `maxTurns` to cap worst-case cost |
| Excerpt length | `src/rag-server.ts` | 400 chars | Raise for richer context, lower for cheaper synthesis |

---

## Swapping the RAG Store

The current store is **in-memory MiniSearch (BM25)**. It resets between runs — fine for demos, not for production.

To use a persistent store:

1. Replace `src/rag-server.ts` with a new MCP server that wraps your store
2. Keep the same 4 tool names: `index_document`, `search_documents`, `list_indexed`, `clear_index`
3. Keep the same input/output contracts — no other files need to change

Good options: **pgvector** (Postgres), **Pinecone**, **Weaviate**, **SQLite + sqlite-vec**.

---

## Adding a New Agent

1. Create `src/agents/myAgent.ts` with an `AgentDefinition`
2. Import and register it in `src/orchestrator.ts` under `agents:`
3. Add a formatter in `src/agentFormatters.ts`
4. Update `src/prompt.ts` to describe the new agent to the orchestrator
5. Add any new tools it needs to `src/toolConfig.ts`
