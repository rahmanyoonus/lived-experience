const NANO_USD_PER_USD = 1_000_000_000;

/**
 * One reviewable source for the optional prompt-generation boundary.
 * Pricing is the documented standard Responses API price for GPT-5.6 Luna as
 * checked on 2026-07-21. Re-check it before changing the model or deploying.
 */
export const OPENAI_GUIDANCE_PROVIDER_POLICY = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1/responses",
  model: "gpt-5.6-luna",
  reasoningEffort: "none",
  maxStoryExcerptCharacters: 12_000,
  maxPreviousPromptCharacters: 240,
  maxRequestBytes: 32_000,
  maxProviderResponseBytes: 64_000,
  maxInputTokens: 4_500,
  maxOutputTokens: 160,
  inputNanoUsdPerToken: 1_000,
  outputNanoUsdPerToken: 6_000,
  providerTimeoutMs: 30_000,
  hardMonthlyBudgetNanoUsd: 50 * NANO_USD_PER_USD,
  // Share the existing one-dollar buffer with transcription.
  operatingMonthlyBudgetNanoUsd: 49 * NANO_USD_PER_USD,
} as const;
