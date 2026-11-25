import { readFileSync, rmSync } from 'node:fs';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type BaseMessage } from '@langchain/core/messages';
import { JsonPlusSerializer } from '@langchain/langgraph-checkpoint';
import { atomicWrite } from '../store.ts';

/** Atomic single-file canonical history. One writer process per file; independent files isolate sessions. */
export class OptChatFileMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain_optchat', 'file_history'];
  private tail: Promise<unknown> = Promise.resolve();
  private serde = new JsonPlusSerializer();
  constructor(readonly file: string) { super(); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run); this.tail = next.catch(() => {}); return next;
  }
  private async read(): Promise<BaseMessage[]> {
    let bytes: Uint8Array;
    try { bytes = readFileSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    return mapStoredMessagesToChatMessages(await this.serde.loadsTyped(envelope.type, Uint8Array.from(envelope.data)));
  }
  private async write(messages: BaseMessage[]) {
    const [type, data] = await this.serde.dumpsTyped(mapChatMessagesToStoredMessages(messages));
    atomicWrite(this.file, JSON.stringify({ type, data: [...data] }));
  }
  getMessages() { return this.serial(() => this.read()); }
  addMessage(message: BaseMessage) { return this.addMessages([message]); }
  addMessages(messages: BaseMessage[]) { return this.serial(async () => this.write([...(await this.read()), ...messages])); }
  replaceMessages(messages: BaseMessage[]) { return this.serial(() => this.write(messages)); }
  clear() { return this.serial(async () => { rmSync(this.file, { force: true }); }); }
}
