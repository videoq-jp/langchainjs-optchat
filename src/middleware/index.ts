import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { Memory, VIEW_DOC } from '../library.ts';
import { allowSearch, SEARCH_DOC, CONTINUITY } from '../core/prompts.ts';
import { createMemoryTools } from '../langchain/index.ts';
import { SnapshotStore } from '../langchain/snapshot.ts';
import { optChatMemorySchema, prepareOptChatTurn, recordOptChatMessages, optChatTurnContext, type OptChatMemoryOptions } from '../langgraph/memory-state.ts';

export interface OptChatMiddlewareOptions extends OptChatMemoryOptions {
  /** Upstream default: zoom/date are always available; original-text search is opt-in. */
  search?: boolean;
}
/** Persist the upstream tree/view in ordinary checkpointed agent state. No backend wrapper is required. */
export function createOptChatMiddleware(options: OptChatMiddlewareOptions) {
  const definitions = createMemoryTools(() => { throw new Error('OptChat retrieval tools require the OptChat middleware runtime.'); });
  const tools = options.search ? [...definitions] : definitions.slice(0, 2);
  const navigation = allowSearch(`${VIEW_DOC}${(options.previousExchangeBytes ?? 16_000) > 0 ? CONTINUITY : ''}${options.search ? SEARCH_DOC : ''}`, options.search ?? false)
    .replace(/\bzoom\b/g, 'optchat_zoom').replace(/\bdate\b/g, 'optchat_date').replace(/\bsearch\b/g, 'optchat_search');
  return createMiddleware({
    name: 'OptChatMemory',
    tools,
    stateSchema: z.object({ optchat: optChatMemorySchema }),
    beforeModel: async (state, runtime) => ({
      optchat: await prepareOptChatTurn(state.messages, state.optchat, options, runtime.signal),
    }),
    wrapModelCall: async (request, handler) => {
      // Other beforeModel hooks may have edited the official state after our preparation hook.
      const state = await prepareOptChatTurn(request.messages, request.state.optchat, options, request.runtime.signal);
      const messages = optChatTurnContext(request.messages, state, options, navigation);
      return handler({ ...request, messages });
    },
    afterModel: async (state, runtime) => ({
      optchat: await recordOptChatMessages(state.messages, state.optchat, options, runtime.signal),
    }),
    wrapToolCall: async (request, handler) => {
      const index = tools.findIndex(tool => tool.name === request.toolCall.name);
      if (index < 0) return handler(request);
      // Later afterModel hooks may also edit/delete originals before a tool executes.
      const state = await recordOptChatMessages(request.state.messages, request.state.optchat, options, request.runtime.signal);
      const store = new SnapshotStore(state.saved);
      const { warn, budget, jobs, retryMs } = options.memoryOptions ?? {};
      const memory = new Memory({ store, saved: store.load() }, options.compressor, warn, budget, jobs, retryMs);
      try {
        const active = createMemoryTools(() => memory);
        // A full tool call makes LangChain produce the standard ToolMessage with its original call ID.
        const call = { ...request.toolCall, type: 'tool_call' as const };
        switch (index) {
          case 0: return await active[0].invoke(call, { signal: request.runtime.signal });
          case 1: return await active[1].invoke(call, { signal: request.runtime.signal });
          default: return await active[2].invoke(call, { signal: request.runtime.signal });
        }
      } finally { await memory.close(); }
    },
  });
}
