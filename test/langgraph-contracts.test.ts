import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { InMemoryStore, MemorySaver } from '@langchain/langgraph-checkpoint';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { StateGraph, MessagesAnnotation, START, END, Command, interrupt, REMOVE_ALL_MESSAGES, getStore, StateSchema, MessagesValue, MessagesDeltaValue } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createAgent } from 'langchain';
import { createOptChatNode, withOptChatContext, OptChatAnnotation, optChatMemorySchema } from '../src/langgraph/index.ts';
import { createOptChatMiddleware } from '../src/middleware/index.ts';
import type { Compression } from '../src/library.ts';
import { removeDir } from './support.ts';
const compressor = async (input: Compression) => input.source.slice(0, 200);
const collect = async <T>(source: AsyncIterable<T>) => { const result: T[] = []; for await (const item of source) result.push(item); return result; };

test('graph state update, RemoveMessage, remove-all, time travel, forks, thread isolation and streaming retain native semantics', async () => {
  const seen: BaseMessage[][] = [];
  const saver = new MemorySaver();
  const graph = new StateGraph(OptChatAnnotation)
    .addNode('chat', createOptChatNode({ compressor, model: { invoke: async messages => { seen.push(messages); return new AIMessage('answer'); } } }))
    .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'main' } };
  await graph.invoke({ messages: [new HumanMessage({ id: 'h1', content: 'original secret' })] }, config);
  const original = await graph.getState(config);
  await graph.invoke({ messages: [new HumanMessage({ id: 'h2', content: 'main branch only' })] }, config);
  await graph.updateState(config, { messages: [new HumanMessage({ id: 'h1', content: 'corrected fact' })] });
  await graph.invoke({ messages: [new HumanMessage('follow up')] }, config);
  assert.match(JSON.stringify(seen.at(-1)), /corrected fact/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1)), /original secret/);
  await graph.bulkUpdateState(config, [{ updates: [{ values: { messages: [new HumanMessage({ id: 'h1', content: 'bulk corrected' })] }, asNode: 'chat' }] }]);
  await graph.invoke({ messages: [new HumanMessage('after bulk update')] }, config);
  assert.match(JSON.stringify(seen.at(-1)), /bulk corrected/);
  await graph.updateState(config, { messages: [new RemoveMessage({ id: 'h1' })] });
  await graph.invoke({ messages: [new HumanMessage('after removal')] }, config);
  assert.doesNotMatch(JSON.stringify(seen.at(-1)), /corrected fact|bulk corrected|original secret/);
  await graph.invoke({ messages: [new HumanMessage('fork input')] }, original.config);
  assert.match(JSON.stringify(seen.at(-1)), /original secret/);
  assert.doesNotMatch(JSON.stringify(seen.at(-1)), /main branch only|corrected fact|after removal/);
  assert.equal((await graph.getState(original.config)).values.messages.length, 2);
  assert.ok((await collect(graph.getStateHistory(config))).length > 2);
  await graph.updateState(config, { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })] });
  const streamed = await collect(await graph.stream({ messages: [new HumanMessage('fresh')] }, { ...config, streamMode: 'values' }));
  assert.ok(streamed.length);
  assert.doesNotMatch(JSON.stringify(seen.at(-1)), /original secret|main branch only|fork input/);
  const events = await collect(graph.streamEvents({ messages: [new HumanMessage('events')] }, { configurable: { thread_id: 'events' }, version: 'v2' }));
  assert.ok(events.some(event => event.event === 'on_chain_end'));
  const other = { configurable: { thread_id: 'other' } };
  await graph.invoke({ messages: [new HumanMessage('isolated')] }, other);
  assert.doesNotMatch(JSON.stringify(seen.at(-1)), /fresh/);
  await saver.deleteThread('main');
  assert.equal(await saver.getTuple(config), undefined);
  assert.equal((await graph.getState(other)).values.messages.length, 2);
});

test('native interrupt/Command resume and pending writes work with official MemorySaver', async () => {
  const graph = new StateGraph(OptChatAnnotation)
    .addNode('approval', () => ({ messages: [new AIMessage(`approved: ${interrupt('confirm')}`)] }))
    .addEdge(START, 'approval').addEdge('approval', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'interrupt' } };
  const pending = await graph.invoke({ messages: [new HumanMessage('request')] }, config);
  assert.ok('__interrupt__' in pending);
  const result = await graph.invoke(new Command({ resume: 'yes' }), config);
  assert.equal(result.messages.at(-1)?.content, 'approved: yes');
});

test('standard ToolNode loop preserves calls/results, metadata and current exchange while summarizing past turns', async () => {
  const lookup = tool(async ({ city }) => {
    const store = getStore()!;
    await store.put(['weather'], city, { forecast: 'sunny' });
    return `${city}: ${(await store.get(['weather'], city))!.value.forecast}`;
  }, { name: 'lookup', description: 'Weather', schema: z.object({ city: z.string() }) });
  const seen: BaseMessage[][] = [];
  const chat = createOptChatNode({ compressor, model: { invoke: async messages => {
    seen.push(messages);
    return messages.at(-1)?.type === 'tool' ? new AIMessage('done') : new AIMessage({ content: '', tool_calls: [{ id: 'call', name: 'lookup', args: { city: 'Tokyo' } }] });
  } } });
  const graph = new StateGraph(OptChatAnnotation).addNode('chat', chat).addNode('tools', new ToolNode([lookup]))
    .addEdge(START, 'chat').addConditionalEdges('chat', state => (state.messages.at(-1) as AIMessage).tool_calls?.length ? 'tools' : END)
    .addEdge('tools', 'chat').compile({ checkpointer: new MemorySaver(), store: new InMemoryStore() });
  const result = await graph.invoke({ messages: [new HumanMessage('weather')] }, { configurable: { thread_id: 'tools' } });
  assert.equal(result.messages.length, 4);
  assert.deepEqual(seen[1].map(m => m.type), ['human', 'ai', 'tool']);
  assert.equal((seen[1][2] as import('@langchain/core/messages').ToolMessage).tool_call_id, 'call');
});

class RecordingModel extends FakeListChatModel {
  override bindTools(..._args: Parameters<FakeListChatModel['bindTools']>): this { return this; }
  seen: BaseMessage[][] = [];
  override async _generate(...args: Parameters<FakeListChatModel['_generate']>) { this.seen.push(args[0]); return super._generate(...args); }
}

test('native createAgent middleware works with checkpointer and store; edits/removal/clear never leak through summaries', async () => {
  const model = new RecordingModel({ responses: ['answer'] });
  const saver = new MemorySaver();
  const store = new InMemoryStore();
  const agent = createAgent({ model, tools: [], checkpointer: saver, store, systemPrompt: 'keep this system instruction', middleware: [createOptChatMiddleware({ compressor })] });
  const config = { configurable: { thread_id: 'agent' } };
  await agent.invoke({ messages: [new HumanMessage({ id: 'h', content: 'old secret' })] }, config);
  await agent.invoke({ messages: [new HumanMessage('follow up')] }, config);
  assert.match(JSON.stringify(model.seen.at(-1)), /Historical conversation memory/);
  assert.match(JSON.stringify(model.seen.at(-1)), /keep this system instruction/);
  await agent.invoke({ messages: [new RemoveMessage({ id: 'h' }), new HumanMessage('after delete')] }, config);
  assert.doesNotMatch(JSON.stringify(model.seen.at(-1)), /old secret/);
  const saved = await saver.getTuple(config);
  assert.doesNotMatch(JSON.stringify(saved?.checkpoint.channel_values), /Historical conversation memory/);
  await saver.deleteThread('agent');
  await agent.invoke({ messages: [new HumanMessage('new session')] }, config);
  assert.doesNotMatch(JSON.stringify(model.seen.at(-1)), /old secret|follow up|after delete/);
});

test('official SQLite persistence survives backend close/reopen with checkpoint metadata and full messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-sqlite-'));
  const file = join(dir, 'checkpoints.sqlite');
  const build = (backend: SqliteSaver) => new StateGraph(OptChatAnnotation)
    .addNode('chat', createOptChatNode({ compressor, model: { invoke: async () => new AIMessage('answer') } }))
    .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer: backend });
  let backend = SqliteSaver.fromConnString(file);
  const config = { configurable: { thread_id: 'durable' } };
  try {
    await build(backend).invoke({ messages: [new HumanMessage('persisted')] }, config);
    backend.db.close(); backend = SqliteSaver.fromConnString(file);
    const graph = build(backend);
    assert.equal((await graph.getState(config)).values.messages.length, 2);
    await graph.invoke({ messages: [new HumanMessage('after restart')] }, config);
    assert.equal((await graph.getState(config)).values.messages.length, 4);
    const saver = backend;
    assert.ok((await collect(saver.list(config))).length > 1);
    await saver.deleteThread('durable'); assert.equal(await saver.getTuple(config), undefined);
  } finally { backend.db.close(); removeDir(dir); }
});

test('snapshot context is immutable, keeps system messages/tool pairs and propagates aborts', async () => {
  const messages = [new HumanMessage('older'), new AIMessage('old answer'), new HumanMessage('now')];
  const before = messages.map(m => m.toDict());
  const result = await withOptChatContext(messages, { compressor });
  assert.equal(result.at(-1), messages.at(-1)); assert.deepEqual(messages.map(m => m.toDict()), before);
  await assert.rejects(withOptChatContext(messages, { compressor }, AbortSignal.abort()));
});


test('nested subgraph checkpoints keep their namespaces and are removed with their thread', async () => {
  const saver = new MemorySaver();
  const child = new StateGraph(OptChatAnnotation)
    .addNode('model', createOptChatNode({ compressor, model: { invoke: async () => new AIMessage('child reply') } }))
    .addEdge(START, 'model').addEdge('model', END).compile();
  const parent = new StateGraph(OptChatAnnotation).addNode('child', child)
    .addEdge(START, 'child').addEdge('child', END).compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'nested' } };
  const result = await parent.invoke({ messages: [new HumanMessage('nested input')] }, config);
  assert.equal(result.messages.at(-1)?.content, 'child reply');
  const checkpoints = await collect(saver.list(config));
  assert.ok(checkpoints.some(tuple => tuple.config.configurable?.checkpoint_ns?.startsWith('child:')));
  await saver.deleteThread('nested'); assert.deepEqual(await collect(saver.list(config)), []);
});


for (const [name, field] of [['MessagesValue', MessagesValue], ['MessagesDeltaValue', MessagesDeltaValue]] as const) {
  test(`official StateSchema ${name} reconstructs edited and forked conversation state`, async () => {
    const schema = new StateSchema({ messages: field, optchat: optChatMemorySchema });
    const seen: BaseMessage[][] = [];
    const saver = new MemorySaver();
    const graph = new StateGraph(schema)
      .addNode('chat', createOptChatNode({ compressor, model: { invoke: async messages => { seen.push(messages); return new AIMessage('answer'); } } }))
      .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer: saver });
    const config = { configurable: { thread_id: name } };
    await graph.invoke({ messages: [new HumanMessage({ id: 'original', content: 'seed fact' })] }, config);
    const original = await graph.getState(config);
    await graph.invoke({ messages: [new HumanMessage('later branch')] }, config);
    assert.equal((await graph.getState(config)).values.messages.length, 4);
    await graph.updateState(config, { messages: [new RemoveMessage({ id: 'original' })] });
    await graph.invoke({ messages: [new HumanMessage('after removal')] }, config);
    assert.doesNotMatch(JSON.stringify(seen.at(-1)), /seed fact/);
    await graph.invoke({ messages: [new HumanMessage('fork')] }, original.config);
    assert.match(JSON.stringify(seen.at(-1)), /seed fact/);
    assert.doesNotMatch(JSON.stringify(seen.at(-1)), /later branch|after removal/);
    await saver.deleteThread(name); assert.equal(await saver.getTuple(config), undefined);
  });
}
