import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { createLangChainCompressor } from '../src/langchain/index.ts';
import { Refused, type Compression } from '../src/library.ts';

const input: Compression = { source: 'original '.repeat(150), context: '', part: { l: 0, i: 0 }, images: [] };
const signal = () => new AbortController().signal;

for (const metadata of [
  { finish_reason: 'length' }, { stop_reason: 'max_tokens' }, { finishReason: 'MAX_TOKENS' },
  { generationInfo: { finishReason: 'MAX_TOKENS' } },
  { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
]) {
  test(`cut-off text is retried, not adopted: ${JSON.stringify(metadata)}`, async () => {
    let calls = 0;
    const compressor = createLangChainCompressor({ invoke: async () => ++calls === 1
      ? new AIMessage({ content: 'short but unfinished', response_metadata: metadata })
      : new AIMessage({ content: 'complete summary', response_metadata: { finish_reason: 'stop' } }) });
    assert.equal(await compressor(input, signal()), 'complete summary');
    assert.equal(calls, 2);
  });
}

test('five token-limit responses refuse without saving any partial candidate', async () => {
  let calls = 0;
  const compressor = createLangChainCompressor({ invoke: async () => {
    calls++;
    return new AIMessage({ content: 'partial', response_metadata: { finish_reason: 'length' } });
  } });
  await assert.rejects(compressor(input, signal()), Refused);
  assert.equal(calls, 5);
});

test('refusal/content filtering ends retries immediately', async () => {
  for (const reply of [
    new AIMessage({ content: 'blocked', response_metadata: { finish_reason: 'content_filter' } }),
    new AIMessage({ content: 'blocked', response_metadata: { finishReason: 'SAFETY' } }),
    new AIMessage({ content: 'blocked', additional_kwargs: { refusal: 'cannot answer' } }),
  ]) {
    let calls = 0;
    await assert.rejects(createLangChainCompressor({ invoke: async () => { calls++; return reply; } })(input, signal()), Refused);
    assert.equal(calls, 1);
  }
});

test('tool replies cannot become summary text even with short accompanying prose', async () => {
  let calls = 0;
  const compressor = createLangChainCompressor({ invoke: async () => ++calls === 1
    ? new AIMessage({ content: 'calling tool', tool_calls: [{ name: 'lookup', args: {}, id: '1' }] })
    : new AIMessage('whole answer') });
  assert.equal(await compressor(input, signal()), 'whole answer');
  assert.equal(calls, 2);
});

test('cancellation wins even if a model ignores the signal and returns a valid reply', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel summary');
  let calls = 0;
  const compressor = createLangChainCompressor({ invoke: async (_messages, config) => {
    calls++;
    assert.equal(config?.signal, controller.signal);
    controller.abort(reason);
    return new AIMessage('valid looking text');
  } });
  await assert.rejects(compressor(input, controller.signal), error => error === reason);
  assert.equal(calls, 1);
});

test('only whole replies participate in original shortest-candidate fallback', async () => {
  let calls = 0;
  const compressor = createLangChainCompressor({ invoke: async () => {
    calls++;
    return calls === 1
      ? new AIMessage({ content: 'tiny', response_metadata: { finish_reason: 'length' } })
      : new AIMessage('x'.repeat(100 + calls));
  } }, 10);
  assert.equal(await compressor(input, signal()), 'x'.repeat(102));
  assert.equal(calls, 5);
});

test('provider exceptions propagate without compounding model-owned retries', async () => {
  const error = new Error('no quota');
  let calls = 0;
  await assert.rejects(createLangChainCompressor({ invoke: async () => { calls++; throw error; } })(input, signal()), caught => caught === error);
  assert.equal(calls, 1);
});

test('default compactor sends named inline images and may expand image names into a description', async () => {
  const imageInput = { ...input, source: 'image', images: [{ name: 'diagram.png', image: { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' } }] };
  const compressor = createLangChainCompressor({ invoke: async messages => {
    const content = messages[1].content;
    assert.ok(Array.isArray(content));
    assert.ok(content.some(block => block.type === 'text' && String(block.text).includes('diagram.png')));
    assert.ok(content.some(block => block.type === 'image_url' && JSON.stringify(block).includes('data:image/png;base64,aGVsbG8=')));
    return new AIMessage('The diagram shows a processing pipeline.');
  } });
  assert.equal(await compressor(imageInput, signal()), 'The diagram shows a processing pipeline.');
});

test('image-unsupported models fall back by name once, as in the original engine', async () => {
  let calls = 0;
  const imageInput = { ...input, source: 'image', images: [{ name: 'diagram.png', image: { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' } }] };
  const compressor = createLangChainCompressor({ invoke: async messages => {
    calls++;
    if (calls === 1) throw new Error('images unsupported');
    assert.doesNotMatch(JSON.stringify(messages), /image_url/);
    return new AIMessage('unused for short original');
  } });
  assert.equal(await compressor(imageInput, signal()), 'image');
  assert.equal(calls, 2);
});

test('an empty legacy tool_calls array does not invalidate a complete answer', async () => {
  let calls = 0;
  const compressor = createLangChainCompressor({ invoke: async () => {
    calls++;
    return new AIMessage({ content: 'whole summary', additional_kwargs: { tool_calls: [] } });
  } });
  assert.equal(await compressor(input, signal()), 'whole summary');
  assert.equal(calls, 1);
});

test('oversize image descriptions use original byte-limit guidance, independent of short source names', async () => {
  let calls = 0;
  const imageInput = { ...input, source: 'x', images: [{ name: 'diagram.png', image: { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' } }] };
  const compressor = createLangChainCompressor({ invoke: async messages => {
    calls++;
    if (calls === 1) return new AIMessage('d'.repeat(1000));
    const guidance = messages.at(-1)?.content;
    assert.equal(typeof guidance, 'string');
    assert.match(String(guidance), /512-byte limit/);
    assert.doesNotMatch(String(guidance), /shorter than 0/);
    assert.equal(messages.at(-2)?.content, 'd'.repeat(1000));
    return new AIMessage('A diagram describing a processing pipeline.');
  } });
  assert.equal(await compressor(imageInput, signal()), 'A diagram describing a processing pipeline.');
  assert.equal(calls, 2);
});
