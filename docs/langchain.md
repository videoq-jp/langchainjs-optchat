# LangChain.js / LangGraph.js integration

`langchain-optchat` implements the official conversation-management contracts and adds OptChat summary context. See the [complete compatibility contract](langchain-api.md) for method signatures, tested versions and scenarios.

## Install

This checkout is not yet published:

```sh
# In this checkout
npm ci
npm pack
# In your application
npm install /path/to/langchain-optchat-0.3.0.tgz
# For native createAgent middleware
npm install langchain@^1.6.8
```

Use Node.js 22.19+. Install the model-provider packages of your choice separately. TypeScript consumers can use `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `lib: ["ESNext"]`, `skipLibCheck: false`, and Node.js types when importing filesystem storage. Pi is not required.

## Native createAgent

```ts
import { createAgent } from 'langchain';
import { MemorySaver, InMemoryStore } from '@langchain/langgraph';
import { createLangChainCompressor } from 'langchain-optchat';
import { createOptChatMiddleware } from 'langchain-optchat/middleware';

const compressor = createLangChainCompressor(summaryModel);
const checkpointer = new MemorySaver();
const store = new InMemoryStore();
const agent = createAgent({
  model: chatModel,
  tools: [],
  checkpointer,
  store,
  middleware: [createOptChatMiddleware({ compressor, memoryOptions: { budget: 128_000 } })],
});
const config = { configurable: { thread_id: 'customer-123' } };
await agent.invoke({ messages: [{ role: 'user', content: 'Remember this.' }] }, config);
await agent.invoke({ messages: [{ role: 'user', content: 'What did we decide?' }] }, config);
await checkpointer.deleteThread('customer-123');
```

**Use the official backends directly, as shown above.** The middleware automatically declares an `optchat` field, and the ordinary checkpointer persists its summary tree and views alongside messages. No extra Store is needed for the OptChat tree. Keep your existing Store for cross-thread application data. Production durability depends on the selected official backend.

For SQLite, set `checkpointer: SqliteSaver.fromConnString('./checkpoints.sqlite')` using `@langchain/langgraph-checkpoint-sqlite`. Initialize/configure any database backend according to its official API. The no-wrapper integration tests restore both conversation state and completed summaries through a real SQLite close/reopen.

## StateGraph

```ts
import { HumanMessage } from '@langchain/core/messages';
import { StateGraph, MessagesAnnotation, MemorySaver, START, END } from '@langchain/langgraph';
import { createOptChatNode, OptChatAnnotation } from 'langchain-optchat/langgraph';

const checkpointer = new MemorySaver();
const graph = new StateGraph(OptChatAnnotation)
  .addNode('chat', createOptChatNode({
    model: chatModel,
    compressor,
    instructions: 'Answer in Japanese.',
  }))
  .addEdge(START, 'chat')
  .addEdge('chat', END)
  .compile({ checkpointer });
const config = { configurable: { thread_id: 'customer-123' } };
await graph.invoke({ messages: [new HumanMessage('Hello')] }, config);
```

`OptChatAnnotation` extends the ordinary messages annotation with a checkpointed `optchat` field. For a custom StateSchema, add the public schema explicitly:

```ts
import { StateSchema, MessagesValue } from '@langchain/langgraph';
import { optChatMemorySchema } from 'langchain-optchat/langgraph';
const State = new StateSchema({ messages: MessagesValue, optchat: optChatMemorySchema });
```

Using the old `MessagesAnnotation` alone omits the summary state field, so use the supplied annotation/schema when retaining memory across calls. Native `createAgent` middleware adds it automatically.

Use the official message reducer, editing/removal operations, state APIs, history traversal, forks, streaming and interrupts normally. A standard `ToolNode` can be connected after the model node when the response contains tool calls. The complete current human/tool exchange is passed intact to the model.

The upstream core is restored from the selected checkpoint's `optchat.saved` log, summary nodes and saved views. New messages are appended and only missing nodes are built. Ordinary turns and process restarts preserve completed work. When a message is edited/deleted, only nodes touching the changed suffix are dropped; unaffected prefix nodes survive. Time-travel forks use the tree stored at their own checkpoint.

The historical view is frozen once per human/tool turn. The previous user/final-answer exchange is replayed in full up to 16,000 bytes by default, matching upstream (`previousExchangeBytes: 0` disables it). The binary summary tree and sawtooth compaction rules are the original core's, including the saved compactor view and cache-friendly view prefixes. Defaults are 512-byte leaf summaries and a 128,000-byte high / 64,000-byte low view budget.

The middleware compacts newly logged originals after model responses, drains buildable work at checkpoint boundaries, and saves it. Unlike Pi's continuously running host, lifecycle hooks close/reopen the core between calls; completed summaries and view state are retained. Compactor failures save completed nodes and leave only missing work to retry. This changes scheduling to fit checkpoints, not the summary-tree algorithm.

Original messages never contain synthetic summary messages. The additional `optchat` channel contains the retained log/tree/view and is removed with an ordinary thread deletion. A failed request or an older checkpoint resumes from the state that the official checkpointer actually committed.

## LangChain history and existing history backends

```ts
import { OptChatMessageHistory, OptChatStoreMessageHistory } from 'langchain-optchat';
import { OptChatFileMessageHistory } from 'langchain-optchat/node';
import { HumanMessage } from '@langchain/core/messages';

const history = new OptChatMessageHistory({
  compressor,
  history: new OptChatFileMessageHistory('./history/customer-123.json'),
});
try {
  await history.addUserMessage('Remember this.');
  const originals = await history.getMessages();
  const request = new HumanMessage('What do you remember?');
  const input = await history.context([request], 'Answer in Japanese.');
  const answer = await chatModel.invoke(input);
  await history.addMessages([request, answer]);
  await history.clear();
} finally { await history.close(); }
```

The standard methods return/store originals and follow standard append semantics, including repeated message IDs. The official graph reducer owns ID-based replacement/deletion. `clear()` works without a callback and invalidates summaries.

Pass any official `BaseChatMessageHistory` or `BaseListChatMessageHistory` as `history`. Omit it for the official in-memory history. For a LangGraph store-backed history, use:

```ts
const backend = new OptChatStoreMessageHistory({
  store, sessionId: 'customer-123', namespace: ['chat', 'history'],
});
const history = new OptChatMessageHistory({ history: backend, compressor });
```

Histories store one canonical session record with indexing disabled. Serialize writes per history/session; the official store interface does not provide a cross-process compare-and-swap for append operations. Local file histories likewise require one writer per file.

`RunnableWithMessageHistory` can use `OptChatMessageHistory` directly. That upstream wrapper is deprecated in favor of LangGraph persistence but remains supported and tested. It reads all originals; it does not implicitly select summary context.

`setMessages(messages)` replaces a complete already-reduced snapshot, invalidating edited or deleted content in summaries. Store/file backends provide a single-record replacement; generic official histories fall back to `clear`/`addMessages`.

## Retrieval and limits

`createMemoryTools(() => history.memory)` returns LangChain `optchat_zoom`, `optchat_date`, and `optchat_search` tools for the history's latest derived snapshot. `context()` rereads canonical originals before use, detecting external edits/removals. Run the tools through your normal tool loop. The native middleware automatically registers `optchat_zoom` and `optchat_date`; add `search: true` to enable `optchat_search`. Its tool handler reads the current checkpointed memory state. Do not separately register another tool with these same names when using the middleware.

The built-in compactor and retrieval output are text-based. Original multimodal blocks and tool metadata/artifacts remain intact in canonical histories/checkpoints and the current turn. The historical summary is text, and image-aware summarization requires a suitable custom compressor.

`budget` is a UTF-8 byte target for the summary view, not a limit on the entire model request or on tokens. The complete current turn and system messages are retained. Pending/failed compaction can temporarily leave an oversized view; monitor your model-input budget and compressor errors. Provider authentication/retries belong to the supplied model. Abort signals reach context waits and model calls; hook-local workers close after their state has been checkpointed. Call `history.close()` to stop a standalone history's background compaction; the host owns backend clients and their lifecycle.

## Migration from local 0.1

- Construct histories with `{ compressor, history? }` instead of passing an append-only `Memory` and optional reset callback.
- Use canonical file/store/official history backends for original messages; the old core `FileStore` remains available only for low-level engine uses.
- Standard `addMessages` now appends exactly as official histories do. Use graph reducers or `setMessages` for snapshot replacement instead of treating message IDs as append deduplication keys.
- `createOptChatNode` receives `compressor` and reads the incoming state directly. Remove the per-thread history resolver and terminal persistence node from normal checkpointer-based graphs.
- Use `createOptChatMiddleware` to attach OptChat to native `createAgent`.

Version 0.2 uses a new canonical-history format; it does not silently migrate the unpublished 0.1 append-only profile files.


## Migration from local 0.2

- Pass official checkpointers/stores directly.
- `createAgent` adds and persists `optchat` automatically through the middleware's state schema.
- Plain StateGraph must use `OptChatAnnotation` or add `optchat: optChatMemorySchema` to its custom StateSchema. The model node returns both `messages` and `optchat`.
- Existing threads with no `optchat` field build the tree once from their originals, then reuse it.
- Native agents now have zoom/date tools by default, matching upstream. Exact-text search is opt-in. The previous exchange is replayed up to 16 KB by default.
- The low-level `withOptChatContext` helper is a one-off projection unless supplied a saved state; use the native integration for automatic persistence.
