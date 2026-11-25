# [P2] ツール結果の要約へ対応する呼び出し・引数を渡す

## 問題

`src/langchain/snapshot.ts:appendSnapshot()`はツール呼び出し付きAIMessageも`talk`として登録する。元エンジンの`src/core/memory.ts:callOf()`は`tool`／`echo`と元のログ形式で対応を解決するため、新形式では動作しない。

## 再現

次のメッセージを記録し、長い結果の葉を要約する際のCompressionを確認する。

```ts
new AIMessage({ content: '', tool_calls: [
  { id: 'c1', name: 'lookup', args: { key: 'important' } },
] });
new ToolMessage({ content: 'result '.repeat(200), tool_call_id: 'c1' });
```

保存されるkindが`talk`／`echo`で、結果の葉の`Compression.call`がundefinedになることを確認した。

## 影響

結果だけでは分からない処理対象や引数が要約時に失われる。ツール呼び出しIDは原本に残っていても、元OptChatの結果要約時の補助情報が欠ける。

## 完了条件

- [ ] 公式tool_call_idを使い、結果の葉に対応するツール名・引数を元エンジン相当の要約入力として渡す。
- [ ] 1つのAIMessageに複数の呼び出しがある場合、結果順が異なる場合でも正しく対応させる。
- [ ] 原本のメッセージID、tool_call_id、artifactを変更しない。
- [ ] 過去のツリーID／zoom参照との整合性を保ち、必要なら既存保存形式の移行方針を定義する。
- [ ] middleware、plain graph、standalone historyで回帰テストを追加し、保存・復元後も対応を維持する。

## 対象と前提

`langchain-optchat@0.3.0`のローカル移植版を対象とするレビュー指摘。元リポジトリの既存Pi実装に対する不具合報告ではない。レビュー時のベースコミットは`c1c4cac95bf971577638e4dbd73797363bc5e815`で、移植コードは未コミット。

目標は、元OptChatの意味・増分要約・参照動作を維持しつつ、公式LangChain.js／LangGraph.jsの履歴・状態・永続化APIで利用できること。独自Checkpointer／Storeラッパーは再導入せず、公式バックエンドを直接利用する。

優先度: P2。既存全体テストは475成功・1スキップ・失敗0だが、本Issueの条件を保証する回帰テストが不足している。
