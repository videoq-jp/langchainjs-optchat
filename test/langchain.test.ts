import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, SystemMessage, ChatMessage } from '@langchain/core/messages';
import { InMemoryChatMessageHistory, BaseListChatMessageHistory } from '@langchain/core/chat_history';
import { InMemoryStore } from '@langchain/langgraph-checkpoint';
import { RunnableLambda, RunnableWithMessageHistory } from '@langchain/core/runnables';
import { Refused, type Compression } from '../src/library.ts';
import { OptChatMessageHistory, OptChatStoreMessageHistory, createLangChainCompressor, createMemoryTools } from '../src/langchain/index.ts';
import { OptChatFileMessageHistory } from '../src/node/index.ts';
import { removeDir } from './support.ts';

export const compress = async (input: Compression) => input.source.slice(0, 100);
const map = (messages: import('@langchain/core/messages').BaseMessage[]) => messages.map(m => m.toDict());

test('standard history methods preserve message metadata and repeated IDs, and clear needs no callback', async () => {
  const history = new OptChatMessageHistory({ compressor: compress });
  assert.ok(history instanceof BaseListChatMessageHistory);
  try {
    const messages = [new SystemMessage('system'), new HumanMessage({ id: 'h', content: [{ type: 'text', text: 'Tokyo' }] }),
      new AIMessage({ id: 'a', content: '', tool_calls: [{ id: 'call', name: 'lookup', args: { city: 'Tokyo' } }], usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }),
      new ToolMessage({ id: 't', content: 'sunny', tool_call_id: 'call', artifact: { raw: [1, 2] } }),
      new ChatMessage({ role: 'custom', content: 'custom role' })];
    await history.addMessages(messages);
    assert.deepEqual(map(await history.getMessages()), map(messages));
    // LangChain histories append; the graph reducer is responsible for ID deduplication.
    await history.addMessage(messages[1]);
    assert.equal((await history.getMessages()).length, 6);
    await history.addUserMessage('user'); await history.addAIMessage('AI');
    assert.equal((await history.getMessages()).length, 8);
    await history.clear();
    assert.deepEqual(await history.getMessages(), []);
    assert.equal(history.memory.root.length, 0);
    assert.deepEqual(await history.context([new HumanMessage('new')]), [new HumanMessage('new')]);
    await history.addUserMessage('after clear');
    assert.equal((await history.getMessages()).length, 1);
  } finally { await history.close(); }
});

test('originals can use an official history; external edits/removal invalidate old summaries and tools', async () => {
  const backend = new InMemoryChatMessageHistory();
  const history = new OptChatMessageHistory({ history: backend, compressor: compress });
  try {
    await history.addMessages([new HumanMessage({ id: 'h', content: 'deleted secret' }), new AIMessage('answer')]);
    await history.context([]);
    await backend.clear(); await backend.addMessage(new HumanMessage({ id: 'h', content: 'corrected' }));
    const context = await history.context([]);
    assert.doesNotMatch(JSON.stringify(context), /deleted secret/);
    assert.match(JSON.stringify(context), /corrected/);
    const tools = createMemoryTools(() => history.memory);
    assert.match(String(await tools[0].invoke({ id: 0 })), /corrected/);
    assert.match(await tools[2].invoke({ text: 'deleted secret' }), /No messages/);
  } finally { await history.close(); }
});

test('official BaseStore sessions support atomic replace, edits, reopen, clear and isolation', async () => {
  const store = new InMemoryStore();
  const first = new OptChatStoreMessageHistory({ store, sessionId: 'first' });
  const second = new OptChatStoreMessageHistory({ store, sessionId: 'second' });
  await first.addUserMessage('original'); await first.addAIMessage('answer');
  await second.addUserMessage('isolated');
  const reopened = new OptChatStoreMessageHistory({ store, sessionId: 'first' });
  assert.equal((await reopened.getMessages()).length, 2);
  const history = new OptChatMessageHistory({ history: reopened, compressor: compress });
  try {
    await history.setMessages([new HumanMessage({ id: 'h', content: 'edited' })]);
    assert.equal((await first.getMessages())[0].content, 'edited');
    await history.clear();
    assert.deepEqual(await first.getMessages(), []);
    assert.equal((await second.getMessages()).length, 1);
    assert.equal(await store.get(['optchat', 'history'], 'first'), null);
  } finally { await history.close(); }
});

test('file history atomically replaces originals, survives reopening, preserves artifacts and clears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-file-'));
  try {
    const path = join(dir, 'history.json');
    const first = new OptChatFileMessageHistory(path);
    const messages = [new HumanMessage({ id: 'h', content: 'Tokyo' }), new ToolMessage({ content: 'done', tool_call_id: 'call', artifact: { date: new Date('2026-01-01'), bytes: new Uint8Array([1, 2]) } })];
    await first.addMessages(messages);
    const reopened = new OptChatFileMessageHistory(path);
    assert.deepEqual(map(await reopened.getMessages()), map(messages));
    await reopened.replaceMessages([new HumanMessage('edited')]);
    assert.equal((await first.getMessages())[0].content, 'edited');
    await reopened.clear(); assert.deepEqual(await first.getMessages(), []);
    await first.addUserMessage('new'); assert.equal((await reopened.getMessages()).length, 1);
  } finally { removeDir(dir); }
});

test('official RunnableWithMessageHistory supports two turns, session isolation and clearing', async () => {
  const sessions = new Map(['first', 'second'].map(id => [id, new OptChatMessageHistory({ compressor: compress })]));
  try {
    const chain = new RunnableWithMessageHistory({
      runnable: RunnableLambda.from(async (messages: import('@langchain/core/messages').BaseMessage[]) => new AIMessage(`Seen ${messages.length}`)),
      getMessageHistory: (sessionId: string) => sessions.get(sessionId)!,
    });
    const config = { configurable: { sessionId: 'first' } };
    assert.equal((await chain.invoke([new HumanMessage('one')], config)).content, 'Seen 1');
    assert.equal((await chain.invoke([new HumanMessage('two')], config)).content, 'Seen 3');
    assert.equal((await sessions.get('first')!.getMessages()).length, 4);
    assert.deepEqual(await sessions.get('second')!.getMessages(), []);
    await sessions.get('first')!.clear();
    assert.equal((await chain.invoke([new HumanMessage('new')], config)).content, 'Seen 1');
  } finally { for (const history of sessions.values()) await history.close(); }
});

test('history backend failures propagate and serialized operations recover after failed writes', async () => {
  const backend = new InMemoryChatMessageHistory();
  const add = backend.addMessages.bind(backend);
  let fail = true;
  backend.addMessages = async messages => { if (fail) throw new Error('unavailable'); await add(messages); };
  const history = new OptChatMessageHistory({ history: backend, compressor: compress });
  try {
    await assert.rejects(history.addUserMessage('failed'), /unavailable/);
    fail = false;
    await Promise.all([history.addUserMessage('one'), history.addUserMessage('two')]);
    assert.deepEqual((await history.getMessages()).map(m => m.content), ['one', 'two']);
  } finally { await history.close(); }
});

test('summary context keeps originals, respects cancellation and drops edited history', async () => {
  const history = new OptChatMessageHistory({ compressor: compress, memoryOptions: { budget: 1500 } });
  try {
    const messages = Array.from({ length: 32 }, (_, i) => new HumanMessage({ id: `h${i}`, content: `Fact ${i} ${'detail '.repeat(80)}` }));
    await history.addMessages(messages);
    await history.memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.ok(new TextEncoder().encode(history.memory.render()).length <= 1500);
    const input = await history.context([messages.at(-1)!], 'instruction');
    assert.equal(input[0].content, 'instruction'); assert.equal(input.at(-1), messages.at(-1));
    assert.equal((await history.getMessages()).length, 32);
    await history.setMessages([new HumanMessage('replacement')]);
    assert.doesNotMatch(JSON.stringify(await history.context([])), /Fact 31/);
    await assert.rejects(history.context([], undefined, AbortSignal.abort()));
  } finally { await history.close(); }
});

test('LangChain compressor retries invalid summaries and forwards cancellation', async () => {
  let calls = 0; const controller = new AbortController();
  const compressor = createLangChainCompressor({ invoke: async (_input, options) => {
    assert.equal(options?.signal, controller.signal);
    return new AIMessage(++calls === 1 ? 'x'.repeat(900) : 'retained');
  } });
  const input: Compression = { source: 'x'.repeat(1000), context: '', part: { l: 0, i: 0 }, images: [] };
  assert.equal(await compressor(input, controller.signal), 'retained'); assert.equal(calls, 2);
  await assert.rejects(createLangChainCompressor({ invoke: async () => new AIMessage('') })(input, controller.signal), Refused);
  controller.abort(); await assert.rejects(compressor(input, controller.signal));
});
