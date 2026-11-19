import { resolve } from 'node:path';
import { z } from 'zod';
try {
  process.loadEnvFile(resolve('.env'));
} catch (e: any) {
  if (e.code !== 'ENOENT') throw e;
}
const flag = z.string().transform((s) => s === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(3031),
  APP_URL: z.string().url().default('http://localhost:3031'),
  DATABASE_URL: z.string().default('postgresql://nota:nota-local@127.0.0.1:54330/nota'),
  DATA_DIR: z.string().default('.data'),
  COOKIE_SECRET: z.string().min(32),
  GMI_API_KEY: z.string().default(''),
  GMI_BASE_URL: z.string().url().default('https://api.gmi-serving.com/v1'),
  GMI_MODEL: z.string().default('deepseek-ai/deepseek-v4.1-flash-1017'),
  LLM_CONTEXT_WINDOW: z.coerce.number().int().min(32768).default(1048576),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).default(8192),
  LLM_COMPACT_RATIO: z.coerce.number().min(0.5).max(0.95).default(0.85),
  LLM_REQUEST_IDLE_MS: z.coerce.number().int().default(45000),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  TAVILY_API_KEY: z.string().trim().default(''),
  TAVILY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  ASR_MODEL: z.string().default('gpt-transcribe'),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(24).default(24),
  MAX_AUDIO_SECONDS: z.coerce.number().int().min(10).max(3600).default(600),
  FREE_DAILY_LIMIT: z.coerce.number().int().min(1).default(10),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
  WORKER_ROLE: z.enum(['all', 'agent', 'files', 'tasks']).default('all'),
  BACKGROUND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  BACKGROUND_MAX_TURNS: z.coerce.number().int().min(1).max(24).default(16),
  FILE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  RECORDING_WINDOW_IDLE_MS: z.coerce.number().int().min(100).default(1500),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(256).max(2000).default(1536),
  EMBEDDING_ENABLED: flag.default(true),
  MAX_RUN_SECONDS: z.coerce.number().int().min(30).default(480),
  BILLING_MODE: z.enum(['demo', 'webhook', 'disabled']).default('disabled'),
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  ALLOW_REGISTRATION: flag.default(true),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(overrides: Record<string, unknown> = {}) {
  return schema.parse({ ...process.env, ...overrides });
}
export function safeError(error: unknown, c?: Config) {
  let s = error instanceof Error ? error.message : String(error);
  for (const key of [
    c?.GMI_API_KEY,
    c?.OPENAI_API_KEY,
    c?.TAVILY_API_KEY,
    c?.COOKIE_SECRET,
    c?.PAYMENT_WEBHOOK_SECRET,
  ])
    if (key) s = s.replaceAll(key, '[redacted]');
  return s.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, 1200);
}
