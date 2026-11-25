# [P2] 履歴の画像をOptChatの画像入力へ変換し、要約と詳細参照を維持する

## 問題

`src/langchain/snapshot.ts`の`memoryText()`／`appendSnapshot()`は画像ブロックもJSON文字列として記録する。画像の抽出、安定した画像参照への変換、Storeへの登録がない。元エンジンの`namedImages()`が画像を解決できず、カスタムCompressorにも画像が届かない。

## 再現

`HumanMessage`のcontentに`{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`を含め、`recordOptChatMessages()`に記録用コンプレッサーを渡す。画像の葉でも`Compression.images.length === 0`で、元のbase64文字列がentriesのtextに残ることを確認した。

## 影響

原本と現在ターンには画像が残るが、歴史的な画像の内容を要約できない。画像対応カスタムコンプレッサーを渡せば解決するという現行ガイドも成立しない。長いbase64をテキスト要約へ送る無駄も生じる。

## 完了条件

- [ ] サポートするLangChain画像形式を明示し、元OptChatと同様に画像の参照と実体を分けてコンプレッサーへ渡す。
- [ ] 公式messagesの画像ブロックを保持しつつ、要約入力へ画像base64をそのままテキストとして埋め込まない。
- [ ] 保存・復元時の画像実体／参照の寿命を設計し、SQLite再起動、編集・削除、分岐でも取り違えない。
- [ ] 画像対応コンプレッサーと詳細参照で画像内容を利用できる。テキスト専用コンプレッサー利用時の挙動も明確にする。
- [ ] native middleware、plain graph、standalone history、one-off contextの対応範囲を検証し、非対応形式を黙ってテキスト化しない。
- [ ] ガイドの画像対応説明を実装と一致させる。

## 対象と前提

`langchain-optchat@0.3.0`のローカル移植版を対象とするレビュー指摘。元リポジトリの既存Pi実装に対する不具合報告ではない。レビュー時のベースコミットは`c1c4cac95bf971577638e4dbd73797363bc5e815`で、移植コードは未コミット。

目標は、元OptChatの意味・増分要約・参照動作を維持しつつ、公式LangChain.js／LangGraph.jsの履歴・状態・永続化APIで利用できること。独自Checkpointer／Storeラッパーは再導入せず、公式バックエンドを直接利用する。

優先度: P2。既存全体テストは475成功・1スキップ・失敗0だが、本Issueの条件を保証する回帰テストが不足している。
