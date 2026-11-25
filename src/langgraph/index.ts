import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { ChatModel } from '../langchain/index.ts';
import type { OptChatContextOptions } from './context.ts';
import { prepareOptChatTurn, recordOptChatMessages, optChatTurnContext, type OptChatMemoryState } from './memory-state.ts';
export { OptChatAnnotation, optChatMemorySchema, type OptChatMemoryState, type OptChatMemoryOptions } from './memory-state.ts';
export { withOptChatContext, type OptChatContextOptions } from './context.ts';

export interface OptChatNodeOptions extends OptChatContextOptions {
  model: ChatModel;
  instructions?: string;
}

/** Standard model node. The official checkpointer owns the original state, including edits, removals and forks. */
export function createOptChatNode(options: OptChatNodeOptions) {
  return async (state: { messages: BaseMessage[]; optchat?: OptChatMemoryState }, config: RunnableConfig = {}) => {
    const memory = await prepareOptChatTurn(state.messages, state.optchat, options, config.signal);
    const messages = optChatTurnContext(state.messages, memory, options);
    const input = options.instructions ? [new SystemMessage(options.instructions), ...messages] : messages;
    const reply = await options.model.invoke(input, config);
    const optchat = await recordOptChatMessages([...state.messages, reply], memory, options, config.signal);
    return { messages: [reply], optchat };
  };
}
