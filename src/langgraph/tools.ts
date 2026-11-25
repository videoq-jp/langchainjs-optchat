import { tool, type ToolRuntime } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { Memory, VIEW_DOC } from '../library.ts';
import { allowSearch, SEARCH_DOC, CONTINUITY } from '../core/prompts.ts';
import { createMemoryTools } from '../langchain/index.ts';
import { SnapshotStore } from '../langchain/snapshot.ts';
import { recordOptChatMessages, type OptChatMemoryOptions, type OptChatMemoryState } from './memory-state.ts';

export interface OptChatToolOptions extends OptChatMemoryOptions {
  /** Match the upstream host: zoom/date are enabled, exact original-text search is opt-in. */
  search?: boolean;
}

export function optChatNavigation(options: Pick<OptChatToolOptions, 'search' | 'previousExchangeBytes'>) {
  return allowSearch(`${VIEW_DOC}${(options.previousExchangeBytes ?? 16_000) > 0 ? CONTINUITY : ''}${options.search ? SEARCH_DOC : ''}`, options.search ?? false)
    .replace(/\bzoom\b/g, 'optchat_zoom').replace(/\bdate\b/g, 'optchat_date').replace(/\bsearch\b/g, 'optchat_search');
}

/** Resolve from the current invocation, including edits/forks made after the last model hook. */
export async function withOptChatMemory<T>(
  state: { messages: BaseMessage[]; optchat?: OptChatMemoryState }, options: OptChatMemoryOptions,
  signal: AbortSignal | undefined, run: (memory: Memory) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!state || !Array.isArray(state.messages)) throw new Error('OptChat tools require graph state with messages. Use them in an official ToolNode.');
  const current = await recordOptChatMessages(state.messages, state.optchat, options, signal);
  const store = new SnapshotStore(current.saved);
  const { warn, budget, jobs, retryMs } = options.memoryOptions ?? {};
  const memory = new Memory({ store, saved: store.load() }, options.compressor, warn, budget, jobs, retryMs);
  try { return await run(memory); }
  finally { await memory.close(); }
}

/** Bind these tools to the model and pass the same tools to an official ToolNode. No shared session cache. */
export function createOptChatTools(options: OptChatToolOptions) {
  const definitions = createMemoryTools(() => { throw new Error('OptChat tools require a ToolNode runtime.'); });
  const execute = async (index: number, args: unknown, runtime: ToolRuntime) => {
    const state = runtime.state as { messages: BaseMessage[]; optchat?: OptChatMemoryState };
    return withOptChatMemory(state, options, runtime.signal, async memory => {
      const active = createMemoryTools(() => memory);
      const config = { ...runtime.config, signal: runtime.signal };
      switch (index) {
        case 0: return active[0].invoke(args as never, config);
        case 1: return active[1].invoke(args as never, config);
        default: return active[2].invoke(args as never, config);
      }
    });
  };
  const tools = [
    tool((args, runtime: ToolRuntime) => execute(0, args, runtime), { name: definitions[0].name, description: definitions[0].description, schema: definitions[0].schema }),
    tool((args, runtime: ToolRuntime) => execute(1, args, runtime), { name: definitions[1].name, description: definitions[1].description, schema: definitions[1].schema }),
    tool((args, runtime: ToolRuntime) => execute(2, args, runtime), { name: definitions[2].name, description: definitions[2].description, schema: definitions[2].schema }),
  ];
  return options.search ? tools : tools.slice(0, 2);
}
