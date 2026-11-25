import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage, AIMessage, RemoveMessage } from '@langchain/core/messages';
import { MemorySaver, StateGraph, START, END } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { createAgent, createMiddleware } from 'langchain';
import { OptChatAnnotation, createOptChatNode, type OptChatMemoryState } from '../src/langgraph/index.ts';
import { createOptChatMiddleware } from '../src/middleware/index.ts';
import { type Compression, type Compressor, Memory } from '../src/library.ts';
import { SnapshotStore } from '../src/langchain/snapshot.ts';
import { prepareOptChatTurn, recordOptChatMessages } from '../src/langgraph/memory-state.ts';
import { removeDir } from './support.ts';
const long = (text: string) => `${text} ${'detail '.repeat(150)}`;
const key = (input: Compression) => `${input.part.l}/${input.part.i}`;
const options = { budget: 2000 };
function recorder() {
  const calls: Compression[] = [];
  const compressor: Compressor = async input => { calls.push(input); return input.source.slice(0, 450); };
  return { calls, compressor };
}

test('direct official checkpointer reuses built nodes and saved views; normal turns append only new messages', async () => {
  const { calls, compressor } = recorder();
  const modelInputs: import('@langchain/core/messages').BaseMessage[][] = [];
  const graph = new StateGraph(OptChatAnnotation)
    .addNode('chat', createOptChatNode({ compressor, memoryOptions: options, model: { invoke: async messages => {
      modelInputs.push(messages); return new AIMessage(long('answer'));
    } } }))
    .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'incremental' } };
  await graph.invoke({ messages: [new HumanMessage(long('first'))] }, config);
  const first = (await graph.getState(config)).values.optchat as OptChatMemoryState;
  assert.equal(first.saved.entries.length, 2); assert.equal(first.saved.tree.length, 3);
  assert.equal(calls.length, 3);
  const store = new SnapshotStore(first.saved);
  const originalCore = new Memory({ store, saved: store.load() }, compressor, undefined, options.budget);
  const expectedView = originalCore.render();
  await originalCore.close();
  await graph.invoke({ messages: [new HumanMessage(long('second'))] }, config);
  const second = (await graph.getState(config)).values.optchat as OptChatMemoryState;
  assert.equal(second.saved.entries.length, 4); assert.equal(second.saved.tree.length, 7);
  assert.equal(second.turn!.view, expectedView, 'the next turn starts from the original saved view');
  assert.equal(new Set(calls.map(key)).size, calls.length, 'no previously built node was summarized again');
  for (const node of first.saved.tree) assert.deepEqual(second.saved.tree.find(n => n.l === node.l && n.i === node.i), node);
  assert.equal(modelInputs[1].at(-3)?.type, 'human', 'the previous user/final-answer exchange is replayed');
  assert.equal(modelInputs[1].at(-2)?.type, 'ai');
});

test('native middleware restores the original tree after a real SQLite close/reopen without backend wrappers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-incremental-sqlite-'));
  const { calls, compressor } = recorder();
  const path = join(dir, 'checkpoints.sqlite');
  let backend = SqliteSaver.fromConnString(path);
  const build = () => createAgent({ model: new FakeListChatModel({ responses: [long('answer')] }), tools: [],
    checkpointer: backend, middleware: [createOptChatMiddleware({ compressor, memoryOptions: options })] });
  const config = { configurable: { thread_id: 'restart' } };
  try {
    await build().invoke({ messages: [new HumanMessage(long('first'))] }, config);
    const first = (await backend.get(config))!.channel_values.optchat as OptChatMemoryState;
    assert.equal(first.saved.tree.length, 3);
    const before = calls.length;
    backend.db.close(); backend = SqliteSaver.fromConnString(path);
    await build().invoke({ messages: [new HumanMessage(long('second'))] }, config);
    const second = (await backend.get(config))!.channel_values.optchat as OptChatMemoryState;
    assert.equal(second.saved.entries.length, 4);
    assert.ok(calls.slice(before).every(input => (input.part.i + 1) * 2 ** input.part.l > 2));
    for (const node of first.saved.tree) assert.deepEqual(second.saved.tree.find(n => n.l === node.l && n.i === node.i), node);
    await backend.deleteThread('restart');
    assert.equal(await backend.get(config), undefined);
  } finally { backend.db.close(); removeDir(dir); }
});

test('editing/deletion invalidates only affected suffix nodes; time-travel forks reuse their own saved prefix', async () => {
  const { calls, compressor } = recorder();
  const modelInputs: import('@langchain/core/messages').BaseMessage[][] = [];
  const graph = new StateGraph(OptChatAnnotation)
    .addNode('chat', createOptChatNode({ compressor, memoryOptions: options, model: { invoke: async messages => {
      modelInputs.push(messages); return new AIMessage(long('answer'));
    } } }))
    .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'branches' } };
  await graph.invoke({ messages: [new HumanMessage({ id: 'h1', content: long('prefix') })] }, config);
  const fork = await graph.getState(config);
  await graph.invoke({ messages: [new HumanMessage({ id: 'h2', content: long('obsolete suffix') })] }, config);
  await graph.updateState(config, { messages: [new HumanMessage({ id: 'h2', content: long('corrected suffix') })] });
  let before = calls.length;
  await graph.invoke({ messages: [new HumanMessage(long('after edit'))] }, config);
  assert.ok(calls.slice(before).every(input => (input.part.i + 1) * 2 ** input.part.l > 2));
  assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)), /obsolete suffix/);
  await graph.updateState(config, { messages: [new RemoveMessage({ id: 'h2' })] });
  await graph.invoke({ messages: [new HumanMessage(long('after delete'))] }, config);
  assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)), /obsolete suffix|corrected suffix/);
  before = calls.length;
  await graph.invoke({ messages: [new HumanMessage(long('fork input'))] }, fork.config);
  assert.ok(calls.slice(before).every(input => (input.part.i + 1) * 2 ** input.part.l > 2));
  assert.doesNotMatch(JSON.stringify(modelInputs.at(-1)), /obsolete suffix|corrected suffix|after edit|after delete/);
});

test('failed compaction checkpoints completed nodes and retries only missing work instead of looping forever', async () => {
  const calls: string[] = [];
  let failed = false;
  const compressor: Compressor = async input => {
    calls.push(key(input));
    if (key(input) === '0/0' && !failed) { failed = true; throw new Error('temporary outage'); }
    return input.source.slice(0, 450);
  };
  const settings = { compressor, memoryOptions: { ...options, warn: () => {}, retryMs: 60_000 } };
  const messages = [new HumanMessage(long('first')), new AIMessage(long('answer'))];
  const prepared = await prepareOptChatTurn(messages.slice(0, 1), undefined, settings);
  const saved = await recordOptChatMessages(messages, prepared, settings);
  assert.ok(saved.saved.tree.some(n => n.l === 0 && n.i === 1));
  const restored = await prepareOptChatTurn([...messages, new HumanMessage('next')], saved, settings);
  assert.equal(restored.saved.tree.length, 3);
  assert.equal(calls.filter(k => k === '0/1').length, 1);
  assert.equal(calls.filter(k => k === '0/0').length, 2);
});

class RetrievalModel extends FakeListChatModel {
  override bindTools(..._args: Parameters<FakeListChatModel['bindTools']>): this { return this; }
  override _formatGeneration(text: string) {
    return text === 'zoom' ? { text: '', message: new AIMessage({ content: '', tool_calls: [{ id: 'zoom-call', name: 'optchat_zoom', args: { id: 0 } }] }) } : super._formatGeneration(text);
  }
}

test('native middleware provides upstream zoom/date tools, routes retrieval through checkpointed memory and keeps its frozen turn view', async () => {
  const { compressor } = recorder();
  const middleware = createOptChatMiddleware({ compressor });
  assert.deepEqual(middleware.tools?.map(tool => tool.name), ['optchat_zoom', 'optchat_date']);
  assert.deepEqual(createOptChatMiddleware({ compressor, search: true }).tools?.map(tool => tool.name), ['optchat_zoom', 'optchat_date', 'optchat_search']);
  const checkpointer = new MemorySaver();
  const agent = createAgent({ model: new RetrievalModel({ responses: ['answer', 'zoom', 'done'] }), tools: [], checkpointer, middleware: [middleware] });
  const config = { configurable: { thread_id: 'retrieval' } };
  await agent.invoke({ messages: [new HumanMessage(long('original fact'))] }, config);
  const result = await agent.invoke({ messages: [new HumanMessage('open the original')] }, config);
  const toolResult = result.messages.find(message => message.type === 'tool');
  assert.ok(toolResult);
  assert.match(JSON.stringify(toolResult.content), /original fact/);
  assert.equal((toolResult as import('@langchain/core/messages').ToolMessage).tool_call_id, 'zoom-call');
  assert.equal(result.messages.at(-1)?.content, 'done');
  const state = (await checkpointer.get(config))!.channel_values.optchat as OptChatMemoryState;
  assert.equal(state.turn?.at, 2);
  assert.equal(state.saved.entries.length, result.messages.length);
  assert.ok(!state.turn?.view.includes('open the original'), 'a tool-loop continuation uses the view frozen before its current user input');
});


test('a later official beforeModel hook can remove messages without stale OptChat summaries reaching the model', async () => {
  const { compressor } = recorder();
  const inputs: import('@langchain/core/messages').BaseMessage[][] = [];
  class Observed extends FakeListChatModel {
    override bindTools(..._args: Parameters<FakeListChatModel['bindTools']>): this { return this; }
    override async _generate(...args: Parameters<FakeListChatModel['_generate']>) { inputs.push(args[0]); return super._generate(...args); }
  }
  const remover = createMiddleware({ name: 'RemoveOldFact', beforeModel: state => {
    if (state.messages.at(-1)?.content === 'remove now' && state.messages.some(m => m.id === 'secret')) return { messages: [new RemoveMessage({ id: 'secret' })] };
  } });
  const agent = createAgent({ model: new Observed({ responses: ['answer'] }), tools: [], checkpointer: new MemorySaver(),
    middleware: [createOptChatMiddleware({ compressor }), remover] });
  const config = { configurable: { thread_id: 'hook-order' } };
  await agent.invoke({ messages: [new HumanMessage({ id: 'secret', content: long('private old fact') })] }, config);
  await agent.invoke({ messages: [new HumanMessage('remove now')] }, config);
  assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /private old fact/);
});
