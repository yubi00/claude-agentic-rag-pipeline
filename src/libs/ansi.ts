/** ANSI terminal escape codes. */

export const R  = '\x1b[0m'   // reset
export const B  = '\x1b[1m'   // bold
export const D  = '\x1b[2m'   // dim
export const CY = '\x1b[36m'  // cyan
export const GR = '\x1b[32m'  // green
export const YE = '\x1b[33m'  // yellow
export const MA = '\x1b[35m'  // magenta
export const RE = '\x1b[31m'  // red
export const BL = '\x1b[34m'  // blue

export const AGENT_COLORS: Record<string, string> = {
  researcher:  YE,
  indexer:     BL,
  synthesizer: MA,
}
