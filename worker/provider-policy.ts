const NANO_USD_PER_USD = 1_000_000_000;

/**
 * One reviewable source for the exact provider request and its conservative
 * accounting envelope. Re-verify this policy before changing the model or
 * enabling live credentials.
 */
export const OPENAI_TRANSCRIPTION_PROVIDER_POLICY = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1/audio/transcriptions",
  model: "gpt-4o-mini-transcribe",
  language: "en",
  maxLogicalSegmentDurationMs: 30 * 60 * 1_000,
  maxPartDurationMs: 4 * 60 * 1_000,
  maxPartCount: 16,
  maxPartAttempts: 2,
  maxAudioBytes: 20_000_000,
  hardMonthlyBudgetNanoUsd: 50 * NANO_USD_PER_USD,
  // Preserve a one-dollar buffer for price drift and estimation variance.
  operatingMonthlyBudgetNanoUsd: 49 * NANO_USD_PER_USD,
  estimatedNanoUsdPerMinute: 3_000_000,
  inputNanoUsdPerToken: 1_250,
  outputNanoUsdPerToken: 5_000,
  maxInputTokens: 16_000,
  maxOutputTokens: 2_000,
  reservationSafetyMultiplier: 2,
} as const;
