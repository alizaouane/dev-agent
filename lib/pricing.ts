export type ModelRates = { input: number; output: number };

export const PRICING_PER_MTOK: Record<string, ModelRates> = {
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-7': { input: 5.00, output: 25.00 },
};

export type ApiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export function usageToDollars(model: string, usage: ApiUsage): number {
  const rates = PRICING_PER_MTOK[model] ?? PRICING_PER_MTOK['claude-haiku-4-5'];
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputCost =
    usage.input_tokens * rates.input +
    cacheWrite * rates.input * 1.25 +
    cacheRead * rates.input * 0.1;
  const outputCost = usage.output_tokens * rates.output;
  return (inputCost + outputCost) / 1_000_000;
}
