# 定期運用の自動化

| 対象                | 実行タイミング（JST、GitHub側の遅延あり） | 結果                              |
| ------------------- | ----------------------------------------- | --------------------------------- |
| CodeQL              | PR・main更新、毎週月曜11:11               | Security > Code scanning          |
| 全依存関係のOSV検査 | 毎週月曜10:19                             | Actions / 脆弱性Issue             |
| Dependabot PRの滞留 | 毎日09:43                                 | 48時間以上進まないPRをIssueへ集約 |

定期ワークフローはmainからのみ実行します。ActionsのRun workflowでも確認できます。
依存関係はインストールせず、全てのレビュー済みロックファイルをデータとして検査します。
検査サービスのエラー・未完了は正常扱いしません。脆弱性の発見で定期検査は失敗し、修正版が未提供のものも通知します。
既存のPR向け「新規導入バージョン」検査と、定期的な全体検査を併用します。

通知は所有者を担当者とするBot所有のIssueへ監視項目ごとに集約し、正常化すると閉じます。
再発時は同じIssueを開き直します。Issueに `operations-muted` ラベルを付けると通知の更新を止めます。
滞留検査はPRを変更しません。重大更新の手動レビュー待ちも通知対象です。
人が作成した同名Issueは変更しません。GitHubのIssue通知設定に従って通知されます。

Runtime Updates は毎日09:13 JSTにNode.js・npmの更新PRを準備します。配布物のハッシュ確認、系列別PR、実行環境での検証は [RUNTIME-UPDATES.md](RUNTIME-UPDATES.md) を参照してください。

リリースとnpm公開はOptChat既存の `Publish` ワークフローを使います。GitHub Releaseの公開またはタグを指定した手動実行から、`npm` environmentのOIDCで公開します。Postgres版のrelease-pleaseと自動リリース処理は導入していません。公開用Node 24はCI用ランタイム更新の対象外です。

CIはLinux/Windowsで型チェック・全テスト・ビルドを実施し、npm tarballをNode 22.19 / 22 / 24 / 26の独立consumerで検証します。SQLiteのネイティブビルド以外はインストールスクリプトを実行しません。

元OptChatの更新は毎日09:00 JSTに `.github/upstream.json` の参照済みcommitと比較し、Bot所有の運用Issueで通知します。自動でライブラリのソースを上書きしません。

運用設定の導入元は [langchainjs-postgresの15c1614](https://github.com/videoq-jp/langchainjs-postgres/commit/15c16143636ef0a78c4f1420f908a1629cacfe98) です。Postgres専用のDBサービスやリリース自動化を移さず、OptChatの既存テスト・パッケージ契約に合わせています。

通常PRもmainへはマージキューを使います。CI成功後にGitHubのMerge when ready、または `gh pr merge <番号> --auto` でキューへ進め、`merge_group` のCI成功を待ちます。管理者にも必須チェックを適用します。依存更新の自動処理だけを止める場合は `DEPENDENCY_AUTOMERGE_ENABLED=false` にし、mainの保護は維持してください。
