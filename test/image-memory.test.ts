import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { recordOptChatMessages, prepareOptChatTurn, optChatMemorySchema } from '../src/langgraph/memory-state.ts';
import { OptChatMessageHistory } from '../src/langchain/history.ts';
import { withOptChatContext } from '../src/langgraph/context.ts';
import type { Compression } from '../src/library.ts';

const image = (data = 'aGVsbG8=') => new HumanMessage({ content: [{ type: 'text', text: 'Describe this' }, { type: 'image_url', image_url: `data:image/png;base64,${data}` }] });
function capture() {
  const calls: Compression[] = [];
  return { calls, compressor: async (input: Compression) => { calls.push(input); return 'A small picture.'; } };
}
test('inline images reach compressor as bytes without base64 in source, originals remain intact', async () => {
  const options = capture(), original = image();
  const state = await recordOptChatMessages([original, new AIMessage('answer')], undefined, options);
  assert.equal(options.calls.find(call => call.images.length)?.images[0].image.data, 'aGVsbG8=');
  assert.ok(!state.saved.entries[0].text.includes('aGVsbG8='));
  assert.equal(state.saved.images?.length, 1);
  assert.match(JSON.stringify(original.content), /aGVsbG8=/);
  assert.ok(optChatMemorySchema.parse(state));
});
test('checkpoint JSON restore preserves images; edits/removals prune obsolete bytes and forks stay independent', async () => {
  const options = capture();
  const state = await recordOptChatMessages([image()], undefined, options);
  const restored = JSON.parse(JSON.stringify(state));
  const continued = await recordOptChatMessages([image(), new AIMessage('next')], restored, options);
  assert.deepEqual(continued.saved.images, state.saved.images);
  const edited = await recordOptChatMessages([image('d29ybGQ=')], restored, options);
  assert.equal(edited.saved.images?.length, 1);
  assert.equal(edited.saved.images?.[0].data, 'd29ybGQ=');
  assert.equal(state.saved.images?.[0].data, 'aGVsbG8=');
  const removed = await recordOptChatMessages([], continued, options);
  assert.deepEqual(removed.saved.images, []);
});
test('remote images require resolver, persisted bytes are reused after checkpoint restore', async () => {
  let requests = 0;
  const message = new HumanMessage({ content: [{ type: 'image_url', image_url: 'https://example.com/picture.png' }] });
  const options = { ...capture(), resolveImage: async () => { requests++; return { mimeType: 'image/png' as const, data: new TextEncoder().encode('hello') }; } };
  await assert.rejects(recordOptChatMessages([message], undefined, capture()), /resolveImage/);
  const saved = await recordOptChatMessages([message], undefined, options);
  await recordOptChatMessages([message, new AIMessage('a')], JSON.parse(JSON.stringify(saved)), options);
  assert.equal(requests, 1);
});
test('history and one-off context use multimodal compressor, unsupported images fail explicitly', async () => {
  const options = capture(), history = new OptChatMessageHistory(options);
  try {
    await history.addMessages([image()]);
    await history.context([]);
    assert.ok(options.calls.some(call => call.images.length));
  } finally { await history.close(); }
  const oneoff = capture();
  await withOptChatContext([image(), new AIMessage('yes'), new HumanMessage('next')], oneoff);
  assert.ok(oneoff.calls.some(call => call.images.length));
  await assert.rejects(prepareOptChatTurn([image('!!!!'), new HumanMessage('next')], undefined, capture()), /invalid base64/);
});

test('official SQLite close/reopen retains image bytes and graph continuation uses the saved tree', async () => {
  const { SqliteSaver } = await import('@langchain/langgraph-checkpoint-sqlite');
  const { StateGraph, START, END } = await import('@langchain/langgraph');
  const { OptChatAnnotation } = await import('../src/langgraph/memory-state.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'optchat-image-'));
  const options = capture(), config = { configurable: { thread_id: 'images' } };
  let saver = SqliteSaver.fromConnString(join(directory, 'state.sqlite'));
  const build = () => new StateGraph(OptChatAnnotation)
    .addNode('record', async state => ({ optchat: await recordOptChatMessages(state.messages, state.optchat, options) }))
    .addEdge(START, 'record').addEdge('record', END).compile({ checkpointer: saver });
  try {
    await build().invoke({ messages: [image()] }, config);
    saver.db.close();
    saver = SqliteSaver.fromConnString(join(directory, 'state.sqlite'));
    const graph = build();
    const restored = await graph.getState(config);
    assert.equal(restored.values.optchat.saved.images[0].data, 'aGVsbG8=');
    const result = await graph.invoke({ messages: [new AIMessage('continued')] }, config);
    assert.deepEqual(result.optchat?.saved.images, restored.values.optchat.saved.images);
    assert.deepEqual(result.optchat?.saved.tree[0], restored.values.optchat.saved.tree[0]);
  } finally { saver.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('history resolver failure leaves no partial cache entries and recovery preserves canonical originals once', async () => {
  let fail = true;
  const options = { ...capture(), resolveImage: async () => {
    if (fail) throw new Error('image fetch failed');
    return { mimeType: 'image/png' as const, data: new TextEncoder().encode('hello') };
  } };
  const history = new OptChatMessageHistory(options);
  const picture = new HumanMessage({ content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/p.png' } }] });
  try {
    await assert.rejects(history.addMessages([new HumanMessage('first'), picture]), /image fetch failed/);
    assert.equal((await history.getMessages()).length, 2);
    fail = false;
    await history.context([]);
    const saved = await history.memory.store.load();
    assert.equal(saved.entries.length, 2);
    assert.equal(options.calls.filter(call => call.images.length).length, 1);
    const before = (await history.getMessages()).length;
    await assert.rejects(history.addMessages([image('!!!!')]), /invalid base64/);
    assert.equal((await history.getMessages()).length, before);
  } finally { await history.close(); }
});

test('remote image resolution receives cancellation and aborts even when resolver ignores signal', async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const message = new HumanMessage({ content: [{ type: 'image_url', image_url: 'https://example.com/slow.png' }] });
  const options = { ...capture(), resolveImage: (_url: string, signal?: AbortSignal) => {
    received = signal;
    controller.abort(new Error('cancel image'));
    return new Promise<{ mimeType: 'image/png'; data: Uint8Array }>(() => {});
  } };
  await assert.rejects(recordOptChatMessages([message], undefined, options, controller.signal), /cancel image/);
  assert.equal(received, controller.signal);
});
