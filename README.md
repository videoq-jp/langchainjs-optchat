# langchain-optchat

OptChat summary-tree conversation memory for **LangChain.js and LangGraph.js**.

This independent integration adapts the MIT-licensed memory engine from [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat). Canonical messages and execution state use the official history, checkpointer and store contracts. The upstream summary tree and its views are retained in checkpointed `optchat` state. Normal turns append only new messages; edits/deletions invalidate only affected suffix nodes, and forks restore their own saved tree.

[日本語ガイド](docs/langchain.ja.md) · [Integration guide](docs/langchain.md) · [API compatibility contract](docs/langchain-api.md)

## Install

This package has not been published to npm. Source and tracked fixes: [yukiharada1228/langchain-optchat](https://github.com/yukiharada1228/langchain-optchat). See [release preparation](docs/npm-release.md).

```sh
# In this checkout
npm ci
npm pack
# In your application (adjust the path)
npm install /path/to/langchain-optchat-0.3.0.tgz
# When using native createAgent middleware
npm install langchain@^1.6.8
```

Node.js 22.19+ is required. Install a LangChain model provider separately. Pi is neither a runtime nor a public type dependency. Strict TypeScript consumers can use `skipLibCheck: false` and `lib: ["ESNext"]`.

## Native LangChain agents

```ts
import { createAgent } from 'langchain';
import { MemorySaver, InMemoryStore } from '@langchain/langgraph';
import { createLangChainCompressor } from 'langchain-optchat';
import { createOptChatMiddleware } from 'langchain-optchat/middleware';

// chatModel and summaryModel are configured LangChain chat models.
const checkpointer = new MemorySaver();
const store = new InMemoryStore();
const agent = createAgent({
  model: chatModel,
  tools: [],
  checkpointer,
  store,
  middleware: [createOptChatMiddleware({
    compressor: createLangChainCompressor(summaryModel),
  })],
});

const config = { configurable: { thread_id: 'customer-123' } };
await agent.invoke({ messages: [{ role: 'user', content: 'Remember this decision.' }] }, config);
await agent.invoke({ messages: [{ role: 'user', content: 'What did we decide?' }] }, config);
```

Use your existing official checkpointer and store directly. The middleware automatically adds an `optchat` state field that the checkpointer saves alongside original messages. Use `SqliteSaver` or `PostgresSaver` directly for restart durability; `MemorySaver` and `InMemoryStore` are in-memory backends.

## Supported conversation-management APIs

| Contract | Support |
| --- | --- |
| LangChain chat histories | `getMessages`, `addMessage`, `addMessages`, `addUserMessage`, `addAIMessage`, `clear`; standard append semantics, including repeated IDs |
| Existing official history backends | Pass a `BaseChatMessageHistory` or `BaseListChatMessageHistory` to `OptChatMessageHistory` |
| `RunnableWithMessageHistory` | Tested with multiple turns, isolated sessions and clearing |
| Native `createAgent` | Middleware retains incremental memory in checkpointed state, replays the previous exchange, and supplies zoom/date retrieval tools (`search: true` enables search) |
| LangGraph checkpointers | Full `BaseCheckpointSaver` contract, including namespaces, metadata, pending writes, delta histories and thread deletion |
| LangGraph stores | Full `BaseStore` contract, including batch operations, vector search/index options, namespace listing and lifecycle |
| Graph conversation management | Message edits, `RemoveMessage`, remove-all, `updateState`, `bulkUpdateState`, checkpoint history, time-travel forks, subgraphs, streaming and interrupt/resume |

[The compatibility contract](docs/langchain-api.md) lists exact tested versions and the methods/scenarios covered. SQLite checkpoint persistence is tested through close/reopen. Database-specific behavior remains that of the selected official backend; PostgreSQL and Redis services are not required by the offline test suite.

## Faithful incremental OptChat memory

The original core performs 512-byte leaf summaries, binary merges and sawtooth view compaction (128,000 → 64,000 bytes by default). This integration restores its message log, completed nodes, chat view and compaction view from the official checkpoint. It appends new messages and builds only missing nodes; it does not summarize old nodes again on each call or after reopening a persistent checkpointer.

Like the upstream host, the context view is frozen for the current human/tool turn, and the previous user/final-answer exchange is replayed up to 16 KB. `zoom` and `date` are available in native agents; exact-text search is opt-in. Completed compaction work is drained at checkpoint boundaries so it is saved durably. Pi keeps workers alive across turns; this host restores/checkpoints the same core state at lifecycle hooks.

For plain StateGraph, use `OptChatAnnotation` instead of `MessagesAnnotation`, or add `optchat: optChatMemorySchema` to your custom StateSchema. The middleware adds this field automatically for `createAgent`. Reserve the `optchat` field for the integration.

## Standard LangChain history

```ts
import { OptChatMessageHistory, createLangChainCompressor } from 'langchain-optchat';
import { OptChatFileMessageHistory } from 'langchain-optchat/node';

const history = new OptChatMessageHistory({
  history: new OptChatFileMessageHistory('./history/customer-123.json'),
  compressor: createLangChainCompressor(summaryModel),
});
try {
  await history.addUserMessage('Remember this.');
  const originals = await history.getMessages();
  await history.clear(); // works without a reset callback
} finally {
  await history.close();
}
```

`getMessages()` returns original messages. Use `context()` for summary context, or use the native agent middleware. See the guides for graph nodes, storage-backed histories, retrieval tools, input budgets and migration from 0.1.

## Development

```sh
npm run check
npm test
npm run build
```

The upstream Pi source and tests are retained for regression coverage. The npm artifact contains only the library build, integration guides and license notices.

## Attribution

Derived from [pi-optchat](https://github.com/jonaslsaa/pi-optchat) by Jonas, implementing [Victor Taelin's OptChat recipe](https://github.com/jonaslsaa/pi-optchat/blob/main/docs/victor-recipe.md). Original attribution is preserved in `LICENSE` and `THIRD_PARTY_NOTICES.md`. This is an independent package, not an official `@langchain/*` integration.
