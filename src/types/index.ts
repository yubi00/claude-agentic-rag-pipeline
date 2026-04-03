export interface SynthesizerReport {
  confidence: 'high' | 'medium' | 'low'
  missingTopics: string[]
  coverageNotes: string
}
