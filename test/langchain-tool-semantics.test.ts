import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Memory, type Compression } from '../src/core/memory.ts';
import { SnapshotStore, appendSnapshot } from '../src/langchain/snapshot.ts';

function fixture() {
  const store = new SnapshotStore();
  const calls: Compression[] = [];
  const memory = new Memory({ store, saved: store.load() }, async input => { calls.push(input); return 'summary'; });
  return { memory, calls };
}

test('tool summaries match parallel results by ID and retain only the matching call arguments', async () => {
  const { memory, calls } = fixture();
  try {
    await appendSnapshot(memory, [new HumanMessage('question'), new AIMessage({ content: '', tool_calls: [
      { id: 'first', name: 'weather', args: { city: 'Tokyo' } },
      { id: 'second', name: 'calculator', args: { expression: '1+1' } },
    ] }), new ToolMessage({ tool_call_id: 'second', content: 'result '.repeat(150) }),
    new ToolMessage({ tool_call_id: 'first', content: 'weather '.repeat(150) }),
    new ToolMessage({ tool_call_id: 'missing', content: 'missing '.repeat(150) })]);
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    const leaf = (i: number) => calls.find(call => call.part.l === 0 && call.part.i === i)!;
    assert.deepEqual(leaf(2).call, { i: 1, text: 'tool: calculator {"expression":"1+1"}' });
    assert.deepEqual(leaf(3).call, { i: 1, text: 'tool: weather {"city":"Tokyo"}' });
    assert.equal(leaf(4).call, undefined);
  } finally { await memory.close(); }
});

test('search ignores memory tool copies in both formats and retains users and unrelated tools', async () => {
  const { memory } = fixture();
  try {
    await appendSnapshot(memory, [new HumanMessage('needle user'), new AIMessage({ content: '', tool_calls: [
      { id: 'zoom-id', name: 'optchat_zoom', args: { query: 'needle' } },
      { id: 'search-id', name: 'optchat_search', args: { query: 'needle' } },
    ] }), new ToolMessage({ tool_call_id: 'search-id', content: 'needle copy' }),
    new ToolMessage({ tool_call_id: 'zoom-id', content: 'needle copy' }),
    new AIMessage({ content: '', tool_calls: [{ id: 'normal', name: 'search_web', args: { query: 'needle' } }] }),
    new ToolMessage({ tool_call_id: 'normal', name: 'search_web', content: 'needle original' }),
    new HumanMessage('{"role":"tool","name":"optchat_zoom","content":"needle pasted"}'),
    new AIMessage({ content: 'needle explanation', tool_calls: [{ id: 'mixed', name: 'optchat_zoom', args: {} }] })]);
    memory.append('tool', 'zoom {"query":"needle"}');
    memory.append('echo', 'zoom: needle copy');
    memory.append('tool', 'optchat_search {"query":"needle"}');
    memory.append('echo', 'optchat_search: needle copy');
    memory.append('tool', 'search_web {"query":"needle"}');
    assert.deepEqual(memory.search('needle').map(hit => hit.i), [12, 7, 6, 5, 4, 0]);
  } finally { await memory.close(); }
});

test('mixed AI calls search only independent content and non-memory call arguments without changing saved originals', async () => {
  const { memory } = fixture();
  try {
    await appendSnapshot(memory, [new AIMessage({ content: 'independent-text', tool_calls: [
      { id: 'zoom', name: 'optchat_zoom', args: { id: 0, query: 'copied-needle' } },
      { id: 'date', name: 'optchat_date', args: { id: 0, label: 'date-needle' } },
      { id: 'search', name: 'optchat_search', args: { text: 'copied-needle' } },
      { id: 'ordinary', name: 'fetch', args: { query: 'ordinary-needle' } },
    ] })]);
    const original = memory.text(0);
    assert.deepEqual(memory.search('copied-needle'), []);
    assert.deepEqual(memory.search('date-needle').map(hit => hit.i), [0]);
    assert.deepEqual(memory.search('ordinary-needle').map(hit => hit.i), [0]);
    assert.deepEqual(memory.search('independent-text').map(hit => hit.i), [0]);
    assert.equal(memory.text(0), original);
    assert.match(original, /copied-needle/);
  } finally { await memory.close(); }
});
