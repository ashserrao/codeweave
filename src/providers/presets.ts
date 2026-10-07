import type { ProviderPreset } from '../shared/types';

/**
 * Public endpoint URLs for common OpenAI-compatible services. These are starting
 * points only; every field stays editable and no credentials are included.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', requiresKey: true, role: 'intelligence', exampleModel: 'gpt-4o-mini' },
  {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    role: 'intelligence',
    exampleModel: 'anthropic/claude-sonnet-4.5',
    headers: { 'X-Title': 'CodeWeave' },
  },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true, role: 'intelligence', exampleModel: 'llama-3.3-70b-versatile' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true, role: 'intelligence', exampleModel: 'deepseek-chat' },
  { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', requiresKey: true, role: 'intelligence', exampleModel: 'mistral-large-latest' },
  { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', requiresKey: true, role: 'intelligence', exampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  {
    // Self-hosted gateway (https://github.com/diegosouzapw/OmniRoute). Create a key in its dashboard
    // (API Manager). The header stops OmniRoute injecting its own memory/skills into prompts:
    // CodeWeave already sends the context it wants, and the injection costs extra tokens.
    label: 'OmniRoute (gateway)',
    baseUrl: 'http://localhost:20128/v1',
    requiresKey: true,
    role: 'intelligence',
    exampleModel: '',
    headers: { 'x-omniroute-no-memory': 'true' },
  },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', requiresKey: false, role: 'context', exampleModel: 'qwen2.5:3b' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', requiresKey: false, role: 'context', exampleModel: 'qwen2.5-3b-instruct' },
  { label: 'Custom', baseUrl: '', requiresKey: true, role: 'intelligence', exampleModel: '' },
];
