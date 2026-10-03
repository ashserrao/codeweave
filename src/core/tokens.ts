/**
 * Rough token estimate (~4 characters per token for English and code).
 * Used only when a provider does not report usage; results are always labelled "estimated".
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
