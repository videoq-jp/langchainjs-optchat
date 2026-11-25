import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AIMessage, HumanMessage, RemoveMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { StateGraph, MemorySaver, START, END } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { createAgent } from 'langchain';
import { createOptChatMiddleware } from '../src/middleware/index.ts';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createOptChatNode, createOptChatTools, OptChatAnnotation } from '../src/langgraph/index.ts';
import { createMemoryTools } from '../src/langchain/index.ts';
import { OptChatMessageHistory } from '../src/langchain/history.ts';
import { recordOptChatMessages } from '../src/langgraph/memory-state.ts';
import type { Compression } from '../src/library.ts';
import { removeDir } from './support.ts';

const options = { compressor: async (_input: Compression) => 'compressed historical fact', previousExchangeBytes: 0, search: true };
function build(checkpointer: MemorySaver | SqliteSaver, seen: BaseMessage[][] = []) {
  const tools = createOptChatTools(options);
  const graph = new StateGraph(OptChatAnnotation)
    .addNode('chat', createOptChatNode({ ...options, model: { invoke: async messages => {
      seen.push(messages);
      if (messages.at(-1)?.type === 'tool') return new AIMessage('retrieval complete');
      const input = messages.at(-1)?.content;
      if (typeof input === 'string' && input.startsWith('retrieve')) return new AIMessage({ content: '', tool_calls: [
        { id: 'zoom-call', name: 'optchat_zoom', args: { id: 0 } },
        { id: 'date-call', name: 'optchat_date', args: { id: 0 } },
        { id: 'search-call', name: 'optchat_search', args: { text: 'first original' } },
      ] });
      return new AIMessage('initial answer');
    } } }))
    .addNode('tools', new ToolNode(tools, { handleToolErrors: false }))
    .addEdge(START, 'chat').addConditionalEdges('chat', toolsCondition, ['tools', END])
    .addEdge('tools', 'chat').compile({ checkpointer });
  return graph;
}

test('plain graph ToolNode retrieves original text/date/search and preserves tool IDs and the frozen view', async () => {
  const seen: BaseMessage[][] = [], graph = build(new MemorySaver(), seen);
  const config = { configurable: { thread_id: 'retrieval' } };
  await graph.invoke({ messages: [new HumanMessage({ id: 'first', content: 'first original secret '.repeat(60) })] }, config);
  const result = await graph.invoke({ messages: [new HumanMessage('retrieve original')] }, config);
  const messages = result.messages.filter((message): message is ToolMessage => message instanceof ToolMessage);
  assert.deepEqual(messages.map(message => message.tool_call_id).sort(), ['date-call', 'search-call', 'zoom-call']);
  assert.match(String(messages.find(message => message.tool_call_id === 'zoom-call')?.content), /first original secret/);
  assert.match(String(messages.find(message => message.tool_call_id === 'search-call')?.content), /first original/);
  assert.doesNotMatch(String(messages.find(message => message.tool_call_id === 'date-call')?.content), /Invalid Date/);
  assert.equal(result.messages.at(-1)?.content, 'retrieval complete');
  assert.match(JSON.stringify(seen.at(-2)), /optchat_zoom/);
  assert.doesNotMatch(result.optchat!.turn!.view, /retrieve original/);
  assert.equal(result.optchat!.saved.entries.length, result.messages.length);
  const isolated = await graph.invoke({ messages: [new HumanMessage('another thread')] }, { configurable: { thread_id: 'other' } });
  assert.doesNotMatch(JSON.stringify(isolated.optchat), /first original secret/);
});

test('SQLite restart, old checkpoint forks and removals use their own graph retrieval memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'optchat-retrieval-'));
  let backend = SqliteSaver.fromConnString(join(directory, 'memory.sqlite'));
  const config = { configurable: { thread_id: 'durable' } };
  try {
    let graph = build(backend);
    await graph.invoke({ messages: [new HumanMessage({ id: 'first', content: 'first original secret '.repeat(60) })] }, config);
    const past = await graph.getState(config);
    backend.db.close(); backend = SqliteSaver.fromConnString(join(directory, 'memory.sqlite')); graph = build(backend);
    const continued = await graph.invoke({ messages: [new HumanMessage('retrieve after reopen')] }, config);
    assert.match(String(continued.messages.find(message => message instanceof ToolMessage && message.tool_call_id === 'zoom-call')?.content), /first original secret/);
    await graph.updateState(config, { messages: [new RemoveMessage({ id: 'first' })] });
    await graph.invoke({ messages: [new HumanMessage('fresh branch content')] }, config);
    const removed = await graph.getState(config);
    assert.ok(!removed.values.messages.some((message: BaseMessage) => message.id === 'first'));
    const reopened = await new ToolNode(createOptChatTools(options), { handleToolErrors: false }).invoke({
      ...removed.values,
      messages: [...removed.values.messages, new AIMessage({ content: '', tool_calls: [{ id: 'after-delete', name: 'optchat_zoom', args: { id: 0 } }] })],
    });
    assert.match(String(reopened.messages[0].content), /initial answer/);
    assert.doesNotMatch(String(reopened.messages[0].content), /first original secret/);
    const fork = await graph.invoke({ messages: [new HumanMessage('retrieve fork')] }, past.config);
    assert.match(String(fork.messages.find(message => message instanceof ToolMessage && message.tool_call_id === 'zoom-call')?.content), /first original secret/);
    assert.doesNotMatch(JSON.stringify(fork.optchat), /fresh branch content|retrieve after reopen/);
  } finally { backend.db.close(); removeDir(directory); }
});

test('graph ToolNode and standalone history zoom return the original image content blocks', async () => {
  const message = new HumanMessage({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] });
  const state = await recordOptChatMessages([message, new AIMessage({ content: '', tool_calls: [{ id: 'picture', name: 'optchat_zoom', args: { id: 0 } }] })], undefined, options);
  const tools = new ToolNode(createOptChatTools(options), { handleToolErrors: false });
  const result = await tools.invoke({ messages: [message, new AIMessage({ content: '', tool_calls: [{ id: 'picture', name: 'optchat_zoom', args: { id: 0 } }] })], optchat: state });
  const content = result.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[1].type, 'image_url');
  assert.match(JSON.stringify(content[1]), /data:image\/png;base64,aGVsbG8=/);
  const history = new OptChatMessageHistory(options);
  try {
    await history.addMessage(message); await history.context([]);
    const original = await createMemoryTools(() => history.memory)[0].invoke({ id: 0 });
    assert.ok(Array.isArray(original));
    assert.match(JSON.stringify(original[1]), /data:image\/png;base64,aGVsbG8=/);
  } finally { await history.close(); }
});

class ImageRetrievalModel extends FakeListChatModel {
  override bindTools(..._args: Parameters<FakeListChatModel['bindTools']>): this { return this; }
  override _formatGeneration(text: string) {
    return text === 'zoom' ? { text: '', message: new AIMessage({ content: '', tool_calls: [{ id: 'image-zoom', name: 'optchat_zoom', args: { id: 0 } }] }) } : super._formatGeneration(text);
  }
}

test('native middleware restores image bytes into a standard multimodal ToolMessage', async () => {
  const saver = new MemorySaver(), config = { configurable: { thread_id: 'agent-images' } };
  const middleware = createOptChatMiddleware(options);
  const first = createAgent({ model: new ImageRetrievalModel({ responses: ['answer'] }), tools: [], checkpointer: saver, middleware: [middleware] });
  await first.invoke({ messages: [new HumanMessage({ content: [{ type: 'image_url', image_url: 'data:image/png;base64,aGVsbG8=' }] })] }, config);
  const reopened = createAgent({ model: new ImageRetrievalModel({ responses: ['zoom', 'done'] }), tools: [], checkpointer: saver, middleware: [middleware] });
  const result = await reopened.invoke({ messages: [new HumanMessage('show image from history')] }, config);
  const tool = result.messages.find((message): message is ToolMessage => message instanceof ToolMessage);
  assert.equal(tool?.tool_call_id, 'image-zoom');
  assert.ok(Array.isArray(tool?.content));
  assert.match(JSON.stringify(tool.content), /data:image\/png;base64,aGVsbG8=/);
  assert.equal(result.messages.at(-1)?.content, 'done');
});
