# Official API compatibility contract

This contract targets the public TypeScript conversation-management APIs in the following installed versions:

| Package | Verified version |
| --- | --- |
| `@langchain/core` | 1.5.1 |
| `langchain` | 1.6.8 |
| `@langchain/langgraph` | 1.7.5 |
| `@langchain/langgraph-checkpoint` | 1.2.3 |
| `@langchain/langgraph-checkpoint-sqlite` | 1.1.1 (test backend) |

The package declares compatible 1.x peer ranges starting at these versions. Future APIs are not implicitly certified by this test run. Provider-specific database methods are used on the configured backend, not reinvented by OptChat.

## Chat histories

`OptChatMessageHistory` extends the official `BaseListChatMessageHistory` and is structurally compatible with the legacy `BaseChatMessageHistory` interface. It accepts any backend implementing the standard `getMessages`, `addMessages`, and `clear` operations. Its default backend is the official in-memory chat history.

| API | Behavior / coverage |
| --- | --- |
| `getMessages()` | Returns canonical originals, preserving roles, IDs, multimodal content blocks, tool calls/results, usage metadata and artifacts |
| `addMessage(message)` | Appends one message |
| `addMessages(messages)` | Appends a batch in order; repeated IDs are retained, matching standard history semantics |
| `addUserMessage(text)` | Official inherited convenience method |
| `addAIMessage(text)` | Official inherited convenience method |
| `clear()` | Clears canonical history and derived summary state; no reset callback is required |
| `RunnableWithMessageHistory` | Multi-turn integration, isolated sessions, and reuse after clearing |
| `Serializable` APIs | Inherited from the official base class; backend objects are not advertised as serializable LangChain resources |

`OptChatStoreMessageHistory` implements the same methods over any official `BaseStore`, storing one session per key with indexing disabled. Its `replaceMessages` atomically replaces that record when the backend's single-key put is atomic. `OptChatFileMessageHistory` implements the same methods using an atomically replaced local file and the official `JsonPlusSerializer`.

`OptChatMessageHistory.setMessages()` accepts a complete, already-reduced snapshot. It handles edited IDs, deleted messages and branches by invalidating summaries. Backends with `replaceMessages()` use it; generic official history backends fall back to `clear()` then `addMessages()`, which is not a transaction.

## Checkpointers and long-term stores

Pass official checkpointers and stores directly to the graph or agent. OptChat does not wrap or reimplement their public APIs. The checkpointer persists original messages and the incremental `optchat` state; the Store remains available for cross-thread application data through the standard runtime API.

Integration tests exercise MemorySaver and a real SQLite backend, including close/reopen, checkpoint history, forks, namespaces, interrupts and thread deletion. Store integration tests exercise runtime access through native tools and agents. Backend-specific operations, serializers, lifecycle and semantic search remain owned by the selected official backend.

`OptChatStoreMessageHistory` is a separate LangChain chat-history implementation over an official `BaseStore`. Thread deletion and separately stored history deletion remain separate operations. Use history `clear()` or the official store `delete()` to delete long-term records.

## Native execution and conversation state

`createOptChatMiddleware()` uses the official `createMiddleware`/`wrapModelCall` API. It forwards the entire model request with only its message context projected. System messages, runtime, tools, tool choice, model settings and response formats remain under official agent control. The original `messages` never contains synthetic summary messages. A separate checkpointed `optchat` channel retains the original core log/tree/chat view/compaction view. Native agents declare it automatically; plain graphs use `OptChatAnnotation` or add `optchat: optChatMemorySchema` to their StateSchema.

`createOptChatNode()` is a standard StateGraph model node. It reads only the incoming state and returns its response. A checkpointer records final responses and the returned incremental `optchat` state automatically; no custom persistence node, wrapper or per-thread history resolver is required.

Tested scenarios:

- Original state retained across multiple invocations and isolated thread IDs.
- Both `MessagesAnnotation` and modern `StateSchema` message fields (`MessagesValue` and experimental `MessagesDeltaValue`), including reconstruction, removals and forks.
- Same-ID edits through the official reducer and `updateState`.
- `RemoveMessage` and `REMOVE_ALL_MESSAGES`, with deleted text absent from subsequent summaries.
- `bulkUpdateState` and `getStateHistory`.
- Old-checkpoint reads, branching/time travel and exclusion of messages from the other branch.
- Nested subgraph checkpoint namespaces and thread-wide deletion.
- `interrupt()` followed by `Command({ resume })`.
- A standard `ToolNode` loop, tool-call/result IDs and runtime store access.
- `stream()` and `streamEvents(..., { version: 'v2' })`.
- A native `createAgent` using the middleware, checkpointer and store, including removals and deletion/reuse of a thread.
- Strict external TypeScript compilation with `skipLibCheck: false` and no Pi packages installed.

## Upstream fidelity and incremental persistence

The original core binary tree and sawtooth compaction rules are retained; structured LangChain tool logs additionally match call/result IDs and identify retrieval copies. The added `checkpoint` settle mode drains currently buildable work or returns on a retry stall; it does not change node selection, merge order or view folding. Completed nodes, original entry positions and both saved views are restored at the next lifecycle hook. Model-facing memory is frozen per human/tool turn, and the previous user/final-answer exchange is replayed up to 16 KB by default.

Normal continuation and SQLite close/reopen tests count compressor calls and assert no already-built node is recomputed. Editing/deletion tests retain unaffected prefix nodes. Time-travel forks restore their own saved prefix and exclude the other branch. Native agents register zoom/date tools, with search opt-in, and route retrieval through the selected checkpointed tree.

Pass official backends directly. Native hooks persist `optchat` as ordinary checkpointed state; they do not add a separate cross-thread cache whose cleanup would need special wrappers.

## Sources and tests

Official references: [history base class](https://reference.langchain.com/javascript/langchain-core/chat_history/BaseListChatMessageHistory), [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [stores](https://docs.langchain.com/oss/javascript/langgraph/stores), [native middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom).

Executable coverage: `test/langchain.test.ts`, `test/langgraph-contracts.test.ts`, `test/optchat-incremental.test.ts`, `test/langchain-compressor-completion.test.ts`, `test/image-memory.test.ts`, `test/langgraph-retrieval.test.ts`, `test/langchain-tool-semantics.test.ts`, `test/tool-semantics-integration.test.ts`, and the packed consumer in `test/consumer-library`. The integrations compile against the installed official declaration files.

## Review regressions

- Token-limit responses are excluded from completed summary candidates; provider metadata variants, refusals, tool calls and cancellation are covered.
- Inline/URL-resolved image blocks feed the compressor and persist separately in checkpoints. SQLite reopen, edits/deletions, forks, resolver failure/cancellation and multimodal zoom are covered.
- Parallel tool results match calls by ID, and search omits OptChat retrieval copies without dropping independent text or ordinary tool results. Search pagination and restored official history backends are covered.
- Plain graphs expose `createOptChatTools(options)` for official `ToolNode` execution. Models bind the same tools; the node supplies upstream navigation. SQLite reopen, thread isolation, original IDs, forks and removals are covered.

See the entry-point matrix and image resolver contract in [the integration guide](langchain.md). Core algorithm parity does not imply that a standalone history cache survives process restart; graph/agent persistence is provided by the official checkpointer.
