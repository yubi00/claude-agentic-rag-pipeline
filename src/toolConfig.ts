/**
 * Tool configuration for the research session.
 *
 * SESSION_TOOLS   — loaded into the context window (what the model knows about)
 * DISALLOWED_TOOLS — explicitly removed from context (environment-injected MCP bloat)
 * ALLOWED_TOOLS   — what the orchestrator is permitted to actually call
 *
 * Update DISALLOWED_TOOLS if you add/remove MCP servers in Claude Code settings.
 */

/** Tools loaded into the session context window. Subagents inherit from this pool. */
export const SESSION_TOOLS = [
  'Agent',
  'WebSearch',
  'WebFetch',
  'mcp__rag__index_document',
  'mcp__rag__search_documents',
  'mcp__rag__list_indexed',
  'mcp__rag__clear_index',
]

/**
 * Environment-injected MCP servers to strip from context.
 * These come from Claude Code user settings — not registered by this app —
 * and inflate input token costs on every turn if left in.
 */
export const DISALLOWED_TOOLS = [
  'mcp__claude_ai_eraserio__authenticate',
  'mcp__claude_ai_Excalidraw__create_view',
  'mcp__claude_ai_Excalidraw__export_to_excalidraw',
  'mcp__claude_ai_Excalidraw__read_checkpoint',
  'mcp__claude_ai_Excalidraw__read_me',
  'mcp__claude_ai_Excalidraw__save_checkpoint',
  'mcp__claude_ai_Gmail__authenticate',
  'mcp__claude_ai_Google_Calendar__authenticate',
  'mcp__eraser__archiveFile',
  'mcp__eraser__createDiagram',
  'mcp__eraser__createFile',
  'mcp__eraser__deleteDiagram',
  'mcp__eraser__getDiagram',
  'mcp__eraser__getFile',
  'mcp__eraser__listDiagrams',
  'mcp__eraser__listFiles',
  'mcp__eraser__renderBpmnDiagram',
  'mcp__eraser__renderCloudArchitectureDiagram',
  'mcp__eraser__renderElements',
  'mcp__eraser__renderEntityRelationshipDiagram',
  'mcp__eraser__renderFlowchart',
  'mcp__eraser__renderPrompt',
  'mcp__eraser__renderSequenceDiagram',
  'mcp__eraser__updateDiagram',
  'mcp__eraser__updateFile',
]

/** Tools the orchestrator itself is permitted to call (subagents only). */
export const ALLOWED_TOOLS = ['Agent']
