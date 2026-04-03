/**
 * Tool exclusions for the research session.
 *
 * The runtime already provides per-agent `tools` and `allowedTools` in config.ts.
 * This file exists only to remove unrelated environment-injected tools that
 * would otherwise bloat context or appear available when this app does not use them.
 */

/**
 * Environment-injected MCP servers to strip from context.
 * These come from Claude Code user settings — not registered by this app —
 * and inflate input token costs on every turn if left in.
 */
export const BLOCKED_CONTEXT_TOOLS = [
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
