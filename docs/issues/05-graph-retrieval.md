# [P2] plain LangGraphでも保存済みOptChatツリーに対するzoom／date／searchを接続できるようにする

## 問題

`src/langgraph/index.ts:createOptChatNode()`は圧縮済み文脈をモデルへ渡すが、チェックポイントのツリーを参照するツール接続を提供しない。`src/middleware/index.ts`には参照ツールの登録、案内、状態の復元、ToolMessageの返却があるが、plain StateGraphには同等の経路がない。

## 再現・確認

`OptChatAnnotation`＋`createOptChatNode()`の標準グラフを組み立てる。モデルに渡される過去は要約だが、ノードはツールを登録せず、選択されたoptchat.savedを読み取るToolNode用の標準接続も公開しない。一般のToolNodeを接続するだけではOptChat参照を完結できない。

## 影響

要約から省かれた詳細をモデルが原文から取り戻す、元OptChatの基本操作がplain graphでは欠ける。native createAgentとplain graphで機能差が生じる。

## 完了条件

- [ ] 公式StateGraph／ToolNodeの仕組みで、選択されたチェックポイントに対応するzoom／date、任意のsearchを接続する公開APIを提供する。
- [ ] モデルにツール仕様と必要な参照案内を渡し、標準のToolMessageと元tool_call_idを保持する。
- [ ] native middlewareと同様、現在ターンの履歴ビューを固定し、他スレッドや他分岐の原文を参照しない。
- [ ] zoomで原文を開いて回答を継続する一連のグラフをテストし、SQLite再起動、履歴分岐、削除後も検証する。
- [ ] 独自Checkpointer／Storeラッパーや余分な別履歴保存ノードを要求しない。
- [ ] 実行可能な導入例をドキュメントへ追加し、全公開経路の対応表を更新する。

## 対象と前提

`langchain-optchat@0.3.0`のローカル移植版を対象とするレビュー指摘。元リポジトリの既存Pi実装に対する不具合報告ではない。レビュー時のベースコミットは`c1c4cac95bf971577638e4dbd73797363bc5e815`で、移植コードは未コミット。

目標は、元OptChatの意味・増分要約・参照動作を維持しつつ、公式LangChain.js／LangGraph.jsの履歴・状態・永続化APIで利用できること。独自Checkpointer／Storeラッパーは再導入せず、公式バックエンドを直接利用する。

優先度: P2。既存全体テストは475成功・1スキップ・失敗0だが、本Issueの条件を保証する回帰テストが不足している。
