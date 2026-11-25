import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OptChatMessageHistory, createMemoryTools } from 'langchain-optchat';
import { OptChatFileMessageHistory } from 'langchain-optchat/node';
import { createOptChatNode, OptChatAnnotation } from 'langchain-optchat/langgraph';
import { createOptChatMiddleware } from 'langchain-optchat/middleware';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { MessagesAnnotation, StateGraph, MemorySaver, InMemoryStore, START, END } from '@langchain/langgraph';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { BaseListChatMessageHistory, BaseChatMessageHistory } from '@langchain/core/chat_history';
import { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph-checkpoint';
import { createAgent } from 'langchain';

assert.equal(existsSync('node_modules/@earendil-works/pi-ai'), false);
const directory = mkdtempSync(join(tmpdir(), 'langchain-optchat-'));
const compressor = async (input: { source: string }) => input.source.slice(0, 100);
const history = new OptChatMessageHistory({ history: new OptChatFileMessageHistory(join(directory, 'history.json')), compressor });
try {
  const officialHistory: BaseListChatMessageHistory = history;
  const legacyHistory: BaseChatMessageHistory = history;
  await legacyHistory.addUserMessage('hello');
  assert.match(await createMemoryTools(() => history.memory)[2].invoke({ text: 'hello' }), /hello/);
  await officialHistory.clear(); assert.equal((await officialHistory.getMessages()).length, 0);
  const saver: BaseCheckpointSaver = new MemorySaver();
  const store: BaseStore = new InMemoryStore();
  const graph = new StateGraph(OptChatAnnotation)
    .addNode('chat', createOptChatNode({ compressor, model: { invoke: async () => new AIMessage('works') } }))
    .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer: saver, store });
  const config = { configurable: { thread_id: 'test' } };
  await graph.invoke({ messages: [new HumanMessage('hello')] }, config);
  const result = await graph.invoke({ messages: [new HumanMessage('again')] }, config);
  assert.equal(result.messages.length, 4);
  assert.ok(result.optchat?.saved.tree.length);
  assert.equal(result.optchat?.saved.entries.length, 4);
  const agent = createAgent({ model: new FakeListChatModel({ responses: ['agent works'] }), checkpointer: saver, store, tools: [], middleware: [createOptChatMiddleware({ compressor })] });
  const response = await agent.invoke({ messages: [new HumanMessage('native agent')] }, { configurable: { thread_id: 'agent' } });
  assert.equal(response.messages.at(-1)?.content, 'agent works');
  await saver.deleteThread('test'); assert.equal(await saver.getTuple(config), undefined);
  console.log('Strict types and native history/checkpointer/store/createAgent work without Pi.');
} finally {
  await history.close();
  rmSync(directory, { recursive: true, force: true });
}
