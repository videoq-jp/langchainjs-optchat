import type { SavedImage, ImageResolver } from '../langchain/message-images.ts';
import { Annotation, MessagesAnnotation } from '@langchain/langgraph';
import { z } from 'zod';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { Memory, type Entry, type Summary, type MemoryOptions, type Compressor } from '../library.ts';
import { SnapshotStore, appendSnapshot, memoryText, summaryMessage } from '../langchain/snapshot.ts';

export interface OptChatMemoryState {
  version: 1;
  saved: { entries: Entry[]; tree: Summary[]; view?: string; images?: SavedImage[] };
  /** Frozen at the start of the human turn, as in the upstream Pi and Durable hosts. */
  turn?: { at: number; identity: string; view: string };
}
export const optChatMemorySchema = z.object({
  version: z.literal(1),
  saved: z.object({
    entries: z.array(z.object({
      i: z.number().int().nonnegative(), kind: z.enum(['user', 'talk', 'tool', 'echo', 'note', 'work']),
      text: z.string(), date: z.string(), receipt: z.string().optional(),
      origin: z.object({ source: z.string(), conversation: z.string(), message: z.string(), title: z.string(), project: z.string().optional() }).optional(),
    })),
    tree: z.array(z.object({ l: z.number().int().nonnegative(), i: z.number().int().nonnegative(), text: z.string(), size: z.number().int().nonnegative() })),
    view: z.string().optional(),
    images: z.array(z.object({ name: z.string(), mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), data: z.string() })).optional(),
  }),
  turn: z.object({ at: z.number().int().nonnegative(), identity: z.string(), view: z.string() }).optional(),
}).optional();
/** Add this field to a custom StateSchema, or use OptChatAnnotation with the standard messages reducer. */
export const OptChatAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  optchat: Annotation<OptChatMemoryState | undefined>(),
});
export interface OptChatMemoryOptions {
  /** Resolve HTTP(S) image blocks to immutable bytes. Inline images need no resolver. */
  resolveImage?: ImageResolver;
  compressor: Compressor;
  memoryOptions?: MemoryOptions;
  /** Upstream default: replay the previous user/final-answer exchange up to 16 KB. Zero disables it. */
  previousExchangeBytes?: number;
}

const source = (messages: BaseMessage[]) => messages.filter(message => message.type !== 'system');
function commonPrefix(entries: Entry[], messages: BaseMessage[]) {
  let at = 0;
  while (at < entries.length && at < messages.length && entries[at].text === memoryText(messages[at])) at++;
  return at;
}
function truncateView(view: string | undefined, count: number): string | undefined {
  if (!view) return undefined;
  const saved = JSON.parse(view);
  const trim = (value: { parts: [number, number][]; merging: boolean }) => ({
    ...value, parts: value.parts.filter(([l, i]) => (i + 1) * 2 ** l <= count),
  });
  return JSON.stringify({ ...trim(saved), compaction: trim(saved.compaction) });
}
/** Preserve all nodes wholly within the unchanged prefix; discard only nodes touching edits/deletions. */
function restored(state: OptChatMemoryState | undefined, count: number) {
  if (!state || state.version !== 1) return { entries: [], tree: [] };
  return {
    entries: state.saved.entries.slice(0, count),
    images: state.saved.images?.filter(image => state.saved.entries.slice(0, count).some(entry => entry.text.includes(`[image ${image.name}]`))),
    tree: state.saved.tree.filter(node => (node.i + 1) * 2 ** node.l <= count),
    view: count === state.saved.entries.length ? state.saved.view : truncateView(state.saved.view, count),
  };
}
function open(state: OptChatMemoryState | undefined, count: number, options: OptChatMemoryOptions) {
  const store = new SnapshotStore(restored(state, count));
  const { warn, budget, jobs, retryMs } = options.memoryOptions ?? {};
  const memory = new Memory({ store, saved: store.load() }, options.compressor, warn, budget, jobs, retryMs);
  return { store, memory };
}
async function save(memory: Memory, store: SnapshotStore, turn: OptChatMemoryState['turn'], signal?: AbortSignal): Promise<OptChatMemoryState> {
  // Drain currently buildable work, including merges, without waiting forever through a failed model's retries.
  await memory.settle(signal, 'checkpoint');
  await memory.flush();
  return { version: 1, saved: store.snapshot(), ...(turn ? { turn } : {}) };
}
function turnAt(messages: BaseMessage[]) {
  const at = messages.findLastIndex(message => message.type === 'human');
  return at < 0 ? 0 : at;
}
function identity(messages: BaseMessage[], at: number) { return messages[at]?.id ?? (messages[at] ? memoryText(messages[at]) : 'empty'); }

/** Restore the upstream tree/view and freeze a historical view once per human turn. */
export async function prepareOptChatTurn(messages: BaseMessage[], state: OptChatMemoryState | undefined, options: OptChatMemoryOptions, signal?: AbortSignal): Promise<OptChatMemoryState> {
  signal?.throwIfAborted();
  const originals = source(messages), at = turnAt(originals);
  const prefix = commonPrefix(state?.version === 1 ? state.saved.entries : [], originals);
  const sameTurn = state?.turn?.at === at && state.turn.identity === identity(originals, at) && prefix >= at;
  const count = sameTurn ? prefix : Math.min(prefix, at);
  const { memory, store } = open(state, count, options);
  try {
    if (sameTurn) return await save(memory, store, state!.turn, signal);
    await appendSnapshot(memory, originals.slice(count, at), options.resolveImage, signal);
    await memory.settle(signal);
    const turn = { at, identity: identity(originals, at), view: memory.render() };
    return await save(memory, store, turn, signal);
  } finally { await memory.close(); }
}
/** After the model, append only newly logged originals and retain both saved views and all completed summaries. */
export async function recordOptChatMessages(messages: BaseMessage[], state: OptChatMemoryState | undefined, options: OptChatMemoryOptions, signal?: AbortSignal): Promise<OptChatMemoryState> {
  signal?.throwIfAborted();
  const originals = source(messages);
  const prefix = commonPrefix(state?.version === 1 ? state.saved.entries : [], originals);
  const { memory, store } = open(state, prefix, options);
  try {
    await appendSnapshot(memory, originals.slice(prefix), options.resolveImage, signal);
    const turn = state?.turn && prefix >= state.turn.at ? state.turn : undefined;
    return await save(memory, store, turn, signal);
  } finally { await memory.close(); }
}
function previousExchange(messages: BaseMessage[], at: number, limit: number) {
  const past = messages.slice(0, at);
  const human = past.findLastIndex(message => message.type === 'human');
  const answer = past.at(-1);
  if (human < 0 || answer?.type !== 'ai' || ('tool_calls' in answer && Array.isArray(answer.tool_calls) && answer.tool_calls.length)) return [];
  const exchange = [past[human], answer];
  return new TextEncoder().encode(exchange.map(memoryText).join('\n')).length <= limit ? exchange : [];
}
export function optChatTurnContext(messages: BaseMessage[], state: OptChatMemoryState, options: OptChatMemoryOptions, navigation?: string): BaseMessage[] {
  const originals = source(messages), at = turnAt(originals);
  return [
    ...messages.filter(message => message.type === 'system'),
    ...(at ? [new SystemMessage(`${navigation ? navigation + "\n" : ""}${summaryMessage(state.turn!.view)}`)] : []),
    ...previousExchange(originals, at, options.previousExchangeBytes ?? 16_000),
    ...originals.slice(at),
  ];
}
