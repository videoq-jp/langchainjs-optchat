import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { createMemoryTools } from '../langchain/index.ts';
import { optChatNavigation, withOptChatMemory, type OptChatToolOptions } from '../langgraph/tools.ts';
import { optChatMemorySchema, prepareOptChatTurn, recordOptChatMessages, optChatTurnContext } from '../langgraph/memory-state.ts';

export type OptChatMiddlewareOptions = OptChatToolOptions;
/** Persist the upstream tree/view in ordinary checkpointed agent state. No backend wrapper is required. */
export function createOptChatMiddleware(options: OptChatMiddlewareOptions) {
  const definitions = createMemoryTools(() => { throw new Error('OptChat retrieval tools require the OptChat middleware runtime.'); });
  const tools = options.search ? [...definitions] : definitions.slice(0, 2);
  const navigation = optChatNavigation(options);
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
      return withOptChatMemory(request.state, options, request.runtime.signal, async memory => {
        const active = createMemoryTools(() => memory);
        const call = { ...request.toolCall, type: 'tool_call' as const };
        switch (index) {
          case 0: return active[0].invoke(call, { signal: request.runtime.signal });
          case 1: return active[1].invoke(call, { signal: request.runtime.signal });
          default: return active[2].invoke(call, { signal: request.runtime.signal });
        }
      });
    },
  });
}
