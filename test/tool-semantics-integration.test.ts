import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { MemorySaver, InMemoryStore, StateGraph, START, END } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { createAgent } from 'langchain';
import { OptChatMessageHistory, OptChatStoreMessageHistory, createMemoryTools } from '../src/langchain/index.ts';
import { createOptChatMiddleware } from '../src/middleware/index.ts';
import { createOptChatNode, createOptChatTools, OptChatAnnotation, type OptChatMemoryState } from '../src/langgraph/index.ts';
import type { Compression } from '../src/core/memory.ts';

const long = (text: string) => `${text} ${'detail '.repeat(120)}`;
function recorder() {
  const calls: Compression[] = [];
  return { calls, compressor: async (input: Compression) => { calls.push(input); return 'summary'; } };
}
function toolReply(text: string) {
  return new AIMessage({ content: '', tool_calls: [{ id: text, name: text, args: {} }] });
}
class NativeToolsModel extends FakeListChatModel {
  override bindTools(..._args: Parameters<FakeListChatModel['bindTools']>): this { return this; }
  override _formatGeneration(text: string) {
    if (text === 'ordinary') return { text: '', message: toolReply('ordinary') };
    if (text === 'zoom') return { text: '', message: new AIMessage({ content: '', tool_calls: [{ id: 'zoom', name: 'optchat_zoom', args: { id: 0 } }] }) };
    if (text === 'search') return { text: '', message: new AIMessage({ content: '', tool_calls: [{ id: 'search', name: 'optchat_search', args: { text: 'unique-fact' } }] }) };
    return super._formatGeneration(text);
  }
}

test('native middleware saves real tool results as JSON, pairs ordinary calls, and excludes zoom copies after checkpoint restore', async () => {
  const { calls, compressor } = recorder();
  const checkpointer = new MemorySaver();
  const ordinary = tool(() => long('ordinary-result'), { name: 'ordinary', description: 'test result', schema: z.object({}) });
  const build = (responses: string[]) => createAgent({ model: new NativeToolsModel({ responses }), tools: [ordinary], checkpointer,
    middleware: [createOptChatMiddleware({ compressor, search: true })] });
  const config = { configurable: { thread_id: 'native-semantics' } };
  const first = await build(['ordinary', 'zoom', 'done']).invoke({ messages: [new HumanMessage(long('unique-fact'))] }, config);
  const state = (await checkpointer.get(config))!.channel_values.optchat as OptChatMemoryState;
  assert.equal(JSON.parse(state.saved.entries.find(entry => entry.kind === 'echo')!.text).role, 'tool');
  const ordinaryLeaf = calls.find(input => input.part.l === 0 && input.source.includes('ordinary-result'))!;
  assert.equal(ordinaryLeaf.call?.text, 'tool: ordinary {}');
  assert.ok(first.messages.some(message => message.type === 'tool' && JSON.stringify(message.content).includes('unique-fact')));
  const resumed = await build(['search', 'done']).invoke({ messages: [new HumanMessage('find it')] }, config);
  const result = resumed.messages.find(message => message.type === 'tool' && (message as ToolMessage).tool_call_id === 'search')!;
  assert.match(String(result.content), /^1 message contains/);
  assert.match(String(result.content), /unique-fact/);
});

function historicalMessages(): BaseMessage[] {
  const messages: BaseMessage[] = Array.from({ length: 25 }, (_, i) => new HumanMessage({ id: `fact-${i}`, content: `page-needle original ${i}` }));
  messages.push(new AIMessage({ content: '', tool_calls: [{ id: 'real', name: 'fetch', args: { location: 'original' } }] }),
    new ToolMessage({ tool_call_id: 'real', content: long('page-needle external') }),
    new AIMessage({ content: '', tool_calls: [{ id: 'copy', name: 'optchat_zoom', args: { id: 0 } }] }),
    new ToolMessage({ tool_call_id: 'copy', content: long('page-needle copied') }));
  return messages;
}

test('plain ToolNode search paginates checkpointed originals and respects a deletion on a fork', async () => {
  const { compressor } = recorder();
  const saver = new MemorySaver();
  const options = { compressor, search: true };
  const tools = createOptChatTools(options);
  const build = () => new StateGraph(OptChatAnnotation)
    .addNode('chat', createOptChatNode({ ...options, model: { invoke: async messages => {
      const last = messages.at(-1)!;
      if (last.type === 'tool') return new AIMessage('done');
      const before = /^page:(\d+)$/.exec(String(last.content));
      return new AIMessage({ content: '', tool_calls: [{ id: `search-${last.id ?? 'latest'}`, name: 'optchat_search', args: { text: 'page-needle', ...(before ? { before: Number(before[1]) } : {}) } }] });
    } } }))
    .addNode('tools', new ToolNode(tools)).addEdge(START, 'chat')
    .addConditionalEdges('chat', toolsCondition, { tools: 'tools', __end__: END }).addEdge('tools', 'chat').compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'graph-semantics' } };
  const initial = await build().invoke({ messages: [...historicalMessages(), new HumanMessage('search')] }, config);
  const page = String(initial.messages.filter(message => message.type === 'tool').at(-1)!.content);
  assert.match(page, /^26 messages contain/);
  assert.doesNotMatch(page, /copied/);
  const cursor = Number(/before: (\d+)/.exec(page)![1]);
  const fork = await build().getState(config);
  const resumed = await build().invoke({ messages: [new HumanMessage(`page:${cursor}`)] }, config);
  const older = String(resumed.messages.filter(message => message.type === 'tool').at(-1)!.content);
  assert.match(older, /^6 older messages contain/);
  assert.doesNotMatch(older, /Older matches:/);
  const edited = await build().invoke({ messages: [new RemoveMessage({ id: 'fact-24' }), new HumanMessage('search fork')] }, fork.config);
  const forkPage = String(edited.messages.filter(message => message.type === 'tool').at(-1)!.content);
  assert.match(forkPage, /^25 messages contain/);
  assert.doesNotMatch(forkPage, /original 24/);
  assert.equal((await build().getState(fork.config)).values.messages.some((message: BaseMessage) => message.id === 'fact-24'), true);
});

test('official Store-backed history rebuilds tool semantics after reopening and invalidates removed messages', async () => {
  const { calls, compressor } = recorder();
  const store = new InMemoryStore();
  const backend = () => new OptChatStoreMessageHistory({ store, sessionId: 'history-semantics' });
  let history = new OptChatMessageHistory({ compressor, history: backend() });
  await history.addMessages(historicalMessages());
  await history.close();
  history = new OptChatMessageHistory({ compressor, history: backend() });
  try {
    await history.context([]);
    const [,, search] = createMemoryTools(() => history.memory);
    const first = await search.invoke({ text: 'page-needle' });
    assert.match(first, /^26 messages contain/);
    assert.doesNotMatch(first, /copied/);
    assert.equal(calls.find(input => input.part.l === 0 && input.source.includes('page-needle external'))?.call?.text,
      'tool: fetch {"location":"original"}');
    const originals = await history.getMessages();
    await history.setMessages(originals.filter(message => message.id !== 'fact-24'));
    await history.context([]);
    const after = await search.invoke({ text: 'page-needle' });
    assert.match(after, /^25 messages contain/);
    assert.doesNotMatch(after, /original 24/);
  } finally { await history.close(); }
});
