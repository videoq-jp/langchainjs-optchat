/** Optional LangChain.js integration; importing core never loads LangChain. */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { COMPACT, Refused, type Compressor, type Memory } from '../library.ts';
import { compaction, IMPORT_GUIDANCE, tooLong } from '../core/prompts.ts';
import { ref, namedImages } from '../core/images.ts';
import { bytes, cut, NODE } from '../core/memory.ts';
import { searchPage } from '../core/tools.ts';

/** Structural interface also accepts bindTools() runnables and deterministic test models. */
export interface ChatModel {
  invoke(messages: BaseMessage[], options?: RunnableConfig): Promise<AIMessage>;
}

export { OptChatMessageHistory, OptChatStoreMessageHistory, type OptChatHistoryOptions, type ChatHistoryBackend } from './history.ts';

/** Provider integrations expose completion reasons under different response_metadata keys. */
function completion(reply: AIMessage): 'whole' | 'retry' | 'refused' | 'error' {
  const metadata = reply.response_metadata;
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const generation = object(metadata.generationInfo);
  const incomplete = object(metadata.incomplete_details);
  const reasons = [metadata.finish_reason, metadata.stop_reason, metadata.finishReason, metadata.stopReason,
    generation.finish_reason, generation.finishReason,
    incomplete.reason].filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase());
  if (reply.additional_kwargs.refusal || reasons.some(reason =>
    ['content_filter', 'refusal', 'refused', 'safety', 'recitation', 'blocklist', 'prohibited_content', 'spii'].includes(reason))) return 'refused';
  if (metadata.status === 'failed' || reasons.some(reason => ['error', 'aborted', 'cancelled', 'canceled'].includes(reason))) return 'error';
  if (metadata.status === 'incomplete' || reasons.some(reason =>
    ['length', 'max_tokens', 'max_output_tokens', 'max_token', 'model_length', 'tool_calls', 'tool_use', 'function_call', 'pause_turn'].includes(reason))) return 'retry';
  if (reply.tool_calls?.length || reply.invalid_tool_calls?.length || (Array.isArray(reply.additional_kwargs.tool_calls) && reply.additional_kwargs.tool_calls.length > 0) || reply.additional_kwargs.function_call ||
    (Array.isArray(reply.content) && reply.content.some(block => ['tool_use', 'tool_call', 'function_call', 'server_tool_use'].includes(block.type)))) return 'retry';
  if (Array.isArray(reply.content) && reply.content.some(block => block.type === 'refusal')) return 'refused';
  return 'whole';
}

/** LangChain models own provider retries. OptChat bounds summary retries and propagates cancellation. */
export function createLangChainCompressor(model: ChatModel, accepted = NODE * 1.25): Compressor {
  if (!Number.isFinite(accepted) || accepted < 1) throw new Error('accepted must be a positive byte count.');
  return async (input, signal) => {
    signal.throwIfAborted();
    const short = bytes(input.source) <= NODE;
    let images = input.images;
    if (short && !images.length) return input.source;
    const task = () => new HumanMessage({ content: [
      { type: 'text', text: `${input.context}\n\n${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${compaction({ ...input, images })}` },
      ...images.flatMap(({ name, image }) => [
        { type: 'text' as const, text: `\n${ref(name)}` },
        { type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
      ]),
    ] });
    let messages: BaseMessage[] = [new SystemMessage(COMPACT), task()];
    const candidates: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      signal.throwIfAborted();
      let reply: AIMessage;
      try { reply = await model.invoke(messages, { signal }); }
      catch (error) {
        signal.throwIfAborted();
        // Match upstream: retry an image failure once by name only. A provider
        // failure unrelated to images then surfaces on the text-only attempt.
        if (!images.length) throw error;
        images = []; messages = [new SystemMessage(COMPACT), task()]; attempt--; continue;
      }
      signal.throwIfAborted();
      const state = completion(reply);
      if (state === 'refused') throw new Refused('LangChain compactor refused or filtered the summary.');
      if (state === 'error') {
        if (images.length) { images = []; messages = [new SystemMessage(COMPACT), task()]; attempt--; continue; }
        throw new Error('LangChain compactor failed or was aborted.');
      }
      if (short && !images.length) return input.source;
      // A cut-off answer (even short text) or a tool call is never a complete summary.
      if (state === 'retry') continue;
      const text = (typeof reply.content === 'string' ? reply.content : reply.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
        .trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!text) continue;
      candidates.push(text);
      if (bytes(text) <= accepted && (images.length > 0 || bytes(text) < bytes(input.source))) return text;
      messages.push(reply, new HumanMessage(tooLong(bytes(text), cut(text))));
    }
    // Like the original compactor, preserve the shortest whole answer if the model
    // cannot meet the size target. Incomplete answers never enter this fallback.
    if (candidates.length) return candidates.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
    throw new Refused('LangChain compactor returned no whole summary in 5 tries.');
  };
}

export type { ImageResolver } from './message-images.ts';

/** Original messages include their kept images; summary zooms stay text. */
export function createMemoryTools(memory: () => Memory) {
  return [
    tool(async ({ id, n, offset, limit }) => {
      const current = memory(), text = current.zoom(id, n, offset, limit);
      const images = n === 1 ? await namedImages(current.store, text) : [];
      return images.length ? [
        { type: 'text' as const, text },
        ...images.map(({ image }) => ({ type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
      ] : text;
    }, {
      name: 'optchat_zoom', description: 'Open an OptChat memory line id+n, or an original message (n=1). Supports character pagination.',
      schema: z.object({ id: z.number().int().nonnegative(), n: z.number().int().positive().default(1), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(25_000).optional() }),
    }),
    tool(({ id }) => memory().date(id), { name: 'optchat_date', description: 'Read the timestamp of an original OptChat message.', schema: z.object({ id: z.number().int().nonnegative() }) }),
    tool(({ text, before }) => searchPage(memory(), text, before), { name: 'optchat_search', description: 'Search original OptChat messages, newest first. before continues pagination.', schema: z.object({ text: z.string().min(1), before: z.number().int().nonnegative().optional() }) }),
  ] as const;
}
