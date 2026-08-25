import { ClaudeCodeAdapter } from './claude-code/adapter.js';
import { CodexAdapter } from './codex/adapter.js';
import { OpenCodeAdapter } from './opencode/adapter.js';
import { AdapterRegistry } from './registry.js';
import type { SessionAdapter } from './contract.js';

/** Every adapter shipped in V1. Unavailable ones are skipped at runtime. */
export function defaultAdapters(): SessionAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter(), new OpenCodeAdapter()];
}

export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry(defaultAdapters());
}
