# LangChain.js／LangGraph.js 連携

**@videoq-jp/langchainjs-optchat 0.3**は、公式の会話履歴・Checkpointer・Store・`createAgent`ミドルウェアに対応する独立した連携ライブラリです。会話の原本は公式APIで管理し、OptChatの要約ツリーはそこから作るコンテキストとして扱います。

## 導入

npmの組織スコープで公開しています。

```sh
npm install @videoq-jp/langchainjs-optchat
# createAgent用ミドルウェアを使う場合
npm install langchain@^1.6.8
```

Node.js 22.19以降と、利用するモデルのLangChainプロバイダーパッケージが必要です。Piは不要です。TypeScriptでは`module`／`moduleResolution`に`NodeNext`、`lib`に`["ESNext"]`を指定できます。`skipLibCheck: false`での外部プロジェクトからの利用を検証します。

## 公式APIへの対応範囲

| API | 対応 |
| --- | --- |
| `BaseListChatMessageHistory`／旧`BaseChatMessageHistory` | 読み出し・単件／一括追加・ユーザー／AI追加・クリア。公式の履歴実装をバックエンドとして利用可能 |
| `RunnableWithMessageHistory` | 複数ターン、セッション分離、クリア後の再利用 |
| `createAgent` | 公式`wrapModelCall`ミドルウェア。モデルへ渡す入力だけを要約し、原本は変更しない |
| `BaseCheckpointSaver` | `get`・`getTuple`・`list`・`put`・`putWrites`・`deleteThread`・バージョン生成・Delta履歴・Serializer |
| LangGraph `BaseStore` | `batch`・`get`・`put`・`delete`・検索・名前空間一覧・開始／終了。意味検索とIndex設定も公式バックエンドへ引き渡す |
| 状態スキーマ | `MessagesAnnotation`と、`StateSchema`の`MessagesValue`／実験的な`MessagesDeltaValue`を検証 |
| 会話の編集・削除 | 同じIDの更新、`RemoveMessage`、全削除、`updateState`、`bulkUpdateState` |
| 分岐・再開 | 過去チェックポイントからの分岐、履歴取得、サブグラフ、`interrupt`／`Command`による再開 |
| ストリーミング | 公式の`stream`／`streamEvents`を維持 |

対象バージョンとメソッド単位の検証内容は[API互換性契約](langchain-api.md)に記載しています。標準構成では既存の公式Checkpointer／Storeを直接使います。独自のCheckpointer／Storeラッパーは提供しません。SQLiteでの実ファイルの再オープンも検証対象です。PostgreSQLやRedisそのものの実装をこのライブラリで作り直すものではありません。

## createAgentから利用

```ts
import { createAgent } from 'langchain';
import { MemorySaver, InMemoryStore } from '@langchain/langgraph';
import { createLangChainCompressor } from '@videoq-jp/langchainjs-optchat';
import { createOptChatMiddleware } from '@videoq-jp/langchainjs-optchat/middleware';

// chatModelとsummaryModelには設定済みのLangChainチャットモデルを渡す
const checkpointer = new MemorySaver();
const store = new InMemoryStore();
const compressor = createLangChainCompressor(summaryModel);
const agent = createAgent({
  model: chatModel,
  tools: [],
  checkpointer,
  store,
  middleware: [createOptChatMiddleware({ compressor })],
});
const config = { configurable: { thread_id: 'customer-123' } };
await agent.invoke({ messages: [{ role: 'user', content: 'この決定を覚えて' }] }, config);
await agent.invoke({ messages: [{ role: 'user', content: '何を決めた？' }] }, config);
await checkpointer.deleteThread('customer-123');
```

**この構成を標準にしてください。公式のCheckpointer／Storeをそのまま渡し、OptChatのアダプターは追加しません。** ミドルウェアが`optchat`状態フィールドを自動追加し、公式Checkpointerが要約ツリーとビューを保存します。OptChat用に別のStoreを追加する必要もありません。

`MemorySaver`と`InMemoryStore`はメモリ内保存です。再起動後も保持するには、`checkpointer`へ公式の`SqliteSaver`や`PostgresSaver`等を直接渡してください。既存のStoreはユーザー設定等のスレッドをまたぐデータにそのまま使います。DB固有の設定は公式の手順に従います。

## StateGraphから利用

```ts
import { StateGraph, MemorySaver, START, END } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { createOptChatNode, createOptChatTools, OptChatAnnotation } from '@videoq-jp/langchainjs-optchat/langgraph';

const memoryOptions = { compressor, search: true };
const tools = createOptChatTools(memoryOptions);
const graph = new StateGraph(OptChatAnnotation)
  .addNode('chat', createOptChatNode({
    ...memoryOptions,
    model: chatModel.bindTools(tools),
    instructions: '日本語で回答してください。',
  }))
  .addNode('tools', new ToolNode(tools))
  .addEdge(START, 'chat')
  .addConditionalEdges('chat', toolsCondition, ['tools', END])
  .addEdge('tools', 'chat')
  .compile({ checkpointer: new MemorySaver() });
```

`OptChatAnnotation`は、公式のメッセージ状態に要約保存用の`optchat`フィールドを加えたものです。独自の`StateSchema`では、次のようにフィールドを追加します。`createAgent`ではミドルウェアが自動追加します。

```ts
import { StateSchema, MessagesValue } from '@langchain/langgraph';
import { optChatMemorySchema } from '@videoq-jp/langchainjs-optchat/langgraph';
const State = new StateSchema({ messages: MessagesValue, optchat: optChatMemorySchema });
```

従来の`MessagesAnnotation`だけでは要約状態が保存されないため、通常のStateGraphには上記のAnnotation／スキーマを使ってください。

公式のReducer、状態更新、削除、分岐、履歴取得、再開をそのまま使います。最終回答はCheckpointerが保存するため、専用の保存ノードは不要です。ツールを使う場合は通常の`ToolNode`ループを接続します。

## 元のOptChatに合わせた増分処理

元のメモリコアを使い、メッセージログ・完成済みの要約ノード・チャットビュー・要約器用ビューを`optchat`状態へ保存します。次回はそれを復元し、新しいメッセージと不足ノードだけを処理します。毎回の全再要約は行いません。SQLiteを閉じて開き直しても、作成済みノードを再要約しないことを呼び出し回数で検証しています。

- 葉の要約、二分木のマージ、ビューの圧縮は元のコアの処理を使用します。既定の要約サイズは512バイト、ビューは128,000バイトを超えたら64,000バイトへまとめる方式です。
- ユーザー／ツールの同一ターンでは、開始時の過去ビューを固定して使います。前回のユーザー発言と最終回答も既定で16KBまで全文を再提示します。`previousExchangeBytes: 0`で無効化できます。
- 新しく記録した入力・応答はモデル応答後に要約し、保存前に実行可能な処理を完了させます。Piの常駐ワーカーとは実行タイミングが異なりますが、完成した木とビューを保持し、アルゴリズムは変更していません。
- 編集・削除があった場合は、変更箇所以降に触れるノードだけを無効化します。影響しない前半の要約は保持します。分岐はそのチェックポイント自身の木を引き継ぎます。

元の`messages`へ要約用のシステムメッセージを書き込むことはありません。要約データは追加の`optchat`フィールドに保存され、公式のスレッド削除と一緒に消えます。

## 標準の会話履歴として利用

```ts
import { OptChatMessageHistory } from '@videoq-jp/langchainjs-optchat';
import { OptChatFileMessageHistory } from '@videoq-jp/langchainjs-optchat/node';

const history = new OptChatMessageHistory({
  history: new OptChatFileMessageHistory('./history/customer-123.json'),
  compressor,
});
try {
  await history.addUserMessage('覚えておいて');
  const originals = await history.getMessages();
  await history.clear(); // リセットコールバック不要
} finally {
  await history.close();
}
```

`history`には既存の公式`BaseChatMessageHistory`／`BaseListChatMessageHistory`実装を渡せます。省略時は公式のインメモリ履歴です。`OptChatStoreMessageHistory({ store, sessionId, namespace? })`で公式のStoreを保存先にすることもできます。

標準の`addMessages`は、同じIDが含まれていても追加します。IDによる置換・削除は公式Reducerの役割です。`setMessages`はReducer適用後の状態全体を置換する補助APIで、削除・編集時に古い要約を破棄します。Store／ファイル履歴は単一レコードを置換しますが、汎用の公式履歴では`clear`と`addMessages`に分かれるためトランザクションにはなりません。

`getMessages()`は原本全体を返します。単独の履歴から要約入力を作るには`context(currentTurn, instructions?, signal?)`を使います。`RunnableWithMessageHistory`も利用可能ですが、公式側では非推奨のため、新規のエージェントには上記の公式永続化とミドルウェアを推奨します。

## 保存とコンテキストの注意点

- 同じセッション／ファイルへの書き込みは直列化してください。公式Storeの基本API自体はプロセス間の追記用Compare-and-Swapを提供しません。
- スレッドの削除と、スレッドをまたぐStoreの削除は公式仕様どおり別操作です。別途保存した履歴は`clear()`、Store項目は`delete()`で削除します。
- `budget`は要約ビューのUTF-8バイト数の目安です。現在のユーザー／ツールのやり取りとシステムメッセージは保持するため、リクエスト全体のトークン数制限ではありません。
- 元のマルチモーダル入力やツールのメタデータ・artifactは保持します。標準の要約器と検索ツール出力はテキスト用で、過去画像を理解した要約には対応する独自Compressorが必要です。
- `createMemoryTools(() => history.memory)`で直近の要約スナップショットへの検索ツールを作れます。`context()`は原本を再読込して外部の編集・削除も反映します。ネイティブミドルウェアは元実装と同様に`optchat_zoom`／`optchat_date`を登録します。`search: true`で`optchat_search`も追加します。同名ツールを別途二重登録しないでください。

## ローカル版0.1からの変更

`OptChatMessageHistory`のコンストラクターは`{ compressor, history? }`になりました。追記専用`Memory`やリセットコールバックは不要です。グラフノードには`compressor`を渡し、履歴Resolverや最終回答保存ノードを通常のCheckpointer構成から外してください。旧0.1の保存ファイルを暗黙に変換する処理はありません。

詳細と公式資料へのリンクは[英語版](langchain.md)と[API互換性契約](langchain-api.md)を参照してください。


## ローカル版0.2からの変更

公式バックエンドを直接利用する構成を標準にしました。`createAgent`は自動で要約状態を保持します。通常のStateGraphは`OptChatAnnotation`または`optchat: optChatMemorySchema`を追加してください。既存スレッドに要約状態がない場合は一度だけ木を構築し、その後は差分を引き継ぎます。

## 画像・ツールと経路ごとの動作

画像付き原文はそのまま保持し、要約には安定した画像参照と実体を渡します。PNG／JPEG／GIF／WebPのinline画像に対応し、公式Checkpointへ画像データも保存します。`optchat_zoom`は原文の画像ブロックも返します。HTTP(S)画像には`resolveImage(url, signal?)`を指定し、`{ mimeType, data: Uint8Array }`を返してください。取得先・認証・サイズ制限はアプリ側で管理します。チェックポイントからの再開時は保存済みデータを再利用します。画像を解釈するには画像入力対応の要約モデルが必要です。

要約モデルの打ち切り・ツール応答は完成した要約として保存せず、最大5回再試行します。終了理由を返さない独自モデルでは、文章だけから打ち切りを判別できません。ツール結果は`tool_call_id`で呼び出しへ対応付け、結果の順序が変わっても名前・引数を要約へ渡します。原文検索からzoom／search自身のコピーを除外します。

| 経路 | 要約状態の保持 | 詳細参照 |
| --- | --- | --- |
| `createAgent`ミドルウェア | 公式Checkpointerへ自動保存 | zoom／dateを自動登録、searchは任意 |
| 通常のStateGraph | `OptChatAnnotation`等と公式Checkpointer | `createOptChatTools`をモデルと公式ToolNodeへ渡す |
| `OptChatMessageHistory` | プロセス内キャッシュ。原文は選択した履歴バックエンドに保存し、再オープン時はキャッシュを再構築 | `context()`で更新後、`createMemoryTools`で参照 |
| `withOptChatContext` | 単発の文脈投影。保存状態を入力可能 | 自動ツールループには上記graph／agentを使用 |

あるメッセージの削除は、その内容を引用する別メッセージや過去のツール結果まで削除する操作ではありません。全文を消す場合は、それらの原本も公式APIで削除してください。
