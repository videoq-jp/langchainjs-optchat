import type { BaseMessage } from '@langchain/core/messages';
import { prepareOptChatTurn, optChatTurnContext, type OptChatMemoryOptions, type OptChatMemoryState } from './memory-state.ts';
export type OptChatContextOptions = OptChatMemoryOptions;

/** One-off projection. Native middleware/nodes persist optchat state through the official checkpointer. */
export async function withOptChatContext(messages: BaseMessage[], options: OptChatContextOptions, signal?: AbortSignal, saved?: OptChatMemoryState): Promise<BaseMessage[]> {
  const state = await prepareOptChatTurn(messages, saved, options, signal);
  return optChatTurnContext(messages, state, options);
}
