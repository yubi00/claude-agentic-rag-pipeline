# Runner: Claude Agent SDK

Implementation: `src/orchestrator/runner/claudeAgentRunner.ts`

Set `AGENT_PROVIDER=claude` (default) to use this runner.

---

## How it works

The Claude runner wraps the `@anthropic-ai/claude-agent-sdk` `query()` function. The SDK manages the tool loop internally — it calls tools, feeds results back to the model, and loops until the model stops or a turn limit is hit.

```text
claudeAgentRunner.run(agent, prompt, runtime)
  |
  v
query({
  model,
  prompt,
  tools: allowed tool names,
  mcp_servers: [ragServer],   ← synthesizer only
  max_turns
})
  |
  v
streams SdkStreamMessage events
  - system (task_started, task_progress)
  - assistant (thinking, text, tool_use blocks)
  - tool_result
  - result (final text, usage, cost)
```

The runner collects cost and turn count from the `result` message and returns `AgentRunResult`.

---

## Tools

### Researcher

Native SDK tools — declared by name, executed by the Claude platform:

- `WebSearch` — searches the web, returns snippets
- `WebFetch` — fetches a URL, returns HTML/text

No custom implementation needed. The SDK handles retries, timeouts, and content extraction.

Web budgets are enforced via `limiter.ts` and `toolConfig.ts` in the orchestrator.

### Synthesizer

Uses an in-process MCP server (`src/rag/server.ts`) exposed via `mcp_servers`:

- `mcp__rag__search_documents` — semantic search over the indexed knowledge base

The MCP server is created once per runtime and passed into every synthesizer call.

---

## Content flow

```text
researcher
  - WebSearch returns snippets
  - WebFetch returns raw HTML/text
  - model extracts SOURCE blocks from content
  - SOURCE blocks passed back to orchestrator as text

orchestrator (code)
  - parses SOURCE blocks
  - indexes content into RAG store

synthesizer
  - calls search_documents via MCP
  - answers from retrieved chunks
```

Content extraction from fetched pages is done by the model. This is a tradeoff: the model can apply judgment (skip nav, identify relevant sections) but may also summarize or compress content.

---

## Cost profile

| Component | Model | Typical cost/run |
|-----------|-------|-----------------|
| Researcher | claude-haiku-4-5 | ~$0.05–0.10 |
| Synthesizer | claude-haiku-4-5 | ~$0.05–0.10 |
| Total | | ~$0.10–0.19 |

Cost is driven by large context windows — the researcher feeds full fetched page content into the model per turn.

---

## Key env vars

```
AGENT_PROVIDER=claude
ANTHROPIC_API_KEY=...
RESEARCHER_MODEL=claude-haiku-4-5-20251001
SYNTHESIZER_MODEL=claude-haiku-4-5-20251001
```

---

## Tradeoffs vs Vercel runner

| | Claude runner | Vercel runner |
|---|---|---|
| Web tools | Native (platform-managed) | Custom (Tavily + Jina) |
| Content extraction | Model | Code (Jina Reader) |
| JS-heavy pages | Depends on SDK | Handled by Jina |
| Cost/run | ~$0.10–0.19 | ~$0.003–0.015 |
| MCP support | Native | Not needed (tools injected directly) |
| Model flexibility | Claude only | Any model via Vercel AI SDK |
