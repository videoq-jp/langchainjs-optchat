/** Optional LangChain.js integration; importing core never loads LangChain. */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { COMPACT, Refused, type Compressor, type Memory } from '../library.ts';
import { compaction } from '../core/prompts.ts';
import { bytes, NODE } from '../core/memory.ts';
import { searchPage } from '../core/tools.ts';

/** Structural interface also accepts bindTools() runnables and deterministic test models. */
export interface ChatModel {
  invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<AIMessage>;
}

export { OptChatMessageHistory, OptChatStoreMessageHistory, type OptChatHistoryOptions, type ChatHistoryBackend } from './history.ts';

/** LangChain models own provider retries. OptChat bounds summary-size retries and propagates cancellation. */
export function createLangChainCompressor(model: ChatModel, accepted = NODE * 1.25): Compressor {
  if (!Number.isFinite(accepted) || accepted < 1) throw new Error('accepted must be a positive byte count.');
  return async (input, signal) => {
    signal.throwIfAborted();
    if (bytes(input.source) <= NODE && !input.images.length) return input.source;
    if (input.images.length) throw new Error('LangChain compactor supports text only; provide a custom Compressor for images.');
    const messages: BaseMessage[] = [new SystemMessage(COMPACT), new HumanMessage(`${input.context}\n\n${compaction(input)}`)];
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await model.invoke(messages, { signal });
      const text = (typeof reply.content === 'string' ? reply.content : reply.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
        .trim().replace(/^\d+\+\d+\|\s*/, '');
      if (text && !reply.tool_calls?.length && bytes(text) <= accepted && bytes(text) < bytes(input.source)) return text;
      messages.push(new AIMessage(text), new HumanMessage(`Return a nonempty summary shorter than ${Math.min(accepted, bytes(input.source) - 1)} UTF-8 bytes. No tools.`));
    }
    throw new Refused('LangChain compactor returned no valid summary in 5 tries.');
  };
}

/** Text-only retrieval tools. Names are scoped to avoid collisions with an application's tools. */
export function createMemoryTools(memory: () => Memory) {
  return [
    tool(({ id, n, offset, limit }) => memory().zoom(id, n, offset, limit), {
      name: 'optchat_zoom', description: 'Open an OptChat memory line id+n, or an original message (n=1). Supports character pagination.',
      schema: z.object({ id: z.number().int().nonnegative(), n: z.number().int().positive().default(1), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(25_000).optional() }),
    }),
    tool(({ id }) => memory().date(id), { name: 'optchat_date', description: 'Read the timestamp of an original OptChat message.', schema: z.object({ id: z.number().int().nonnegative() }) }),
    tool(({ text, before }) => searchPage(memory(), text, before), { name: 'optchat_search', description: 'Search original OptChat messages, newest first. before continues pagination.', schema: z.object({ text: z.string().min(1), before: z.number().int().nonnegative().optional() }) }),
  ] as const;
}
