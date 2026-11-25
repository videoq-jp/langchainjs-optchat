import type { ImageResolver } from './message-images.ts';
import { BaseListChatMessageHistory, type BaseChatMessageHistory, InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { SystemMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type BaseMessage } from '@langchain/core/messages';
import { type BaseStore } from '@langchain/langgraph-checkpoint';
import type { Compressor, MemoryOptions, Memory } from '../library.ts';
import { appendSnapshot, emptyMemory, memoryText, summaryMessage } from './snapshot.ts';

export type ChatHistoryBackend = Pick<BaseChatMessageHistory | BaseListChatMessageHistory, 'getMessages' | 'addMessages' | 'clear'> & {
  replaceMessages?: (messages: BaseMessage[]) => Promise<void>;
};

/** Standard LangChain history backed by any official LangGraph BaseStore. One key is one session. */
export class OptChatStoreMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain_optchat', 'store_history'];
  private tail: Promise<unknown> = Promise.resolve();
  readonly namespace: string[];
  constructor(readonly options: { store: BaseStore; sessionId: string; namespace?: string[] }) {
    super();
    if (!options.sessionId) throw new Error('sessionId is required.');
    this.namespace = [...(options.namespace ?? ['optchat', 'history'])];
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run); this.tail = next.catch(() => {}); return next;
  }
  private async read() {
    const item = await this.options.store.get(this.namespace, this.options.sessionId);
    return item ? mapStoredMessagesToChatMessages(item.value.messages) : [];
  }
  private async write(messages: BaseMessage[]) {
    await this.options.store.put(this.namespace, this.options.sessionId,
      { messages: mapChatMessagesToStoredMessages(messages) }, false);
  }
  getMessages() { return this.serial(() => this.read()); }
  addMessage(message: BaseMessage) { return this.addMessages([message]); }
  addMessages(messages: BaseMessage[]) { return this.serial(async () => this.write([...(await this.read()), ...messages])); }
  replaceMessages(messages: BaseMessage[]) { return this.serial(() => this.write(messages)); }
  clear() { return this.serial(() => this.options.store.delete(this.namespace, this.options.sessionId)); }
}

export interface OptChatHistoryOptions {
  resolveImage?: ImageResolver;
  compressor: Compressor;
  /** Any official BaseChatMessageHistory or BaseListChatMessageHistory implementation. */
  history?: ChatHistoryBackend;
  memoryOptions?: MemoryOptions;
}

/** Standard append semantics, including repeated message IDs. Graph reducers own ID updates and removals.
 * Original messages are canonical; summary caches are discarded when originals are edited or cleared. */
export class OptChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain_optchat', 'chat_history'];
  readonly backend: ChatHistoryBackend;
  private cache: Memory;
  private cached: string[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly options: OptChatHistoryOptions) {
    super();
    this.backend = options.history ?? new InMemoryChatMessageHistory();
    this.cache = emptyMemory(options.compressor, options.memoryOptions);
  }
  get memory() { return this.cache; }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => { if (this.closed) throw new Error('History is closed.'); return run(); });
    this.tail = next.catch(() => {}); return next;
  }
  private async refresh(messages: BaseMessage[], signal?: AbortSignal) {
    const texts = messages.map(memoryText);
    const extendsCache = texts.length >= this.cached.length && this.cached.every((text, i) => texts[i] === text);
    if (!extendsCache) {
      await this.cache.close();
      this.cache = emptyMemory(this.options.compressor, this.options.memoryOptions);
      this.cached = [];
    }
    try {
      await appendSnapshot(this.cache, messages.slice(this.cached.length), this.options.resolveImage, signal);
      this.cached = texts;
    } catch (error) {
      await this.cache.close();
      this.cache = emptyMemory(this.options.compressor, this.options.memoryOptions);
      this.cached = [];
      throw error;
    }
  }
  getMessages(): Promise<BaseMessage[]> { return this.serial(() => this.backend.getMessages()); }
  addMessage(message: BaseMessage) { return this.addMessages([message]); }
  addMessages(messages: BaseMessage[]) {
    return this.serial(async () => {
      messages.forEach(memoryText);
      await this.backend.addMessages(messages);
      await this.refresh(await this.backend.getMessages());
    });
  }
  /** Replace canonical history with an already-reduced graph snapshot, supporting edits, removals and forks.
   * Backends can implement replaceMessages for atomic replacement; otherwise the official clear/add interface is used. */
  setMessages(messages: BaseMessage[]) {
    return this.serial(async () => {
      messages.forEach(memoryText);
      if (this.backend.replaceMessages) await this.backend.replaceMessages(messages);
      else { await this.backend.clear(); await this.backend.addMessages(messages); }
      await this.refresh(messages);
    });
  }
  clear() {
    return this.serial(async () => {
      await this.backend.clear();
      await this.refresh([]);
    });
  }
  /** Current-turn messages stay intact. Removed/edited source messages invalidate all previous summaries. */
  context(current: BaseMessage[], instructions?: string, signal?: AbortSignal): Promise<BaseMessage[]> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      await this.refresh(await this.backend.getMessages(), signal);
      await this.cache.settle(signal);
      return [
        ...(instructions ? [new SystemMessage(instructions)] : []),
        ...(this.cached.length ? [new SystemMessage(summaryMessage(this.cache.render()))] : []),
        ...current,
      ];
    });
  }
  async close() {
    await this.tail;
    this.closed = true;
    await this.cache.close();
  }
}
