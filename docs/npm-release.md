# npm公開の準備

パッケージ名: `@videoq-jp/langchainjs-optchat`。公開先リポジトリ: https://github.com/videoq-jp/langchainjs-optchat 。初回公開バージョンは`0.3.0`。GitHubとnpmの両方で`videoq-jp`組織を使用する。

## 初回リリースの完了条件

- GitHub Issue #1〜#5を修正し、再現ケースの回帰テストを追加する。
- native createAgent、plain StateGraph、standalone history、one-off contextの対応範囲を検証し、ガイドと一致させる。
- `npm run check`、`npm test`、`npm run build`を通す。
- `npm pack`で作成したtgzを別環境へインストールし、Piなし・`skipLibCheck: false`で型チェックと実行を確認する。
- `npm pack --dry-run`で公開ファイルとメタデータを確認する。

## 公開方法

初回は必要な二要素認証を満たすnpmアカウントで`npm publish --access public`を実行する。初回公開後、npm上でこのリポジトリの`.github/workflows/publish.yml`（environment: `npm`）をTrusted Publisherとして登録し、GitHub側にも対応するEnvironmentを構成する。以後はpackage.jsonのバージョンと一致する`v<version>`タグのGitHub Releaseで公開できる。認証情報をリポジトリへ保存しない。

GitHub Issueの作成やソースのpushだけではnpm公開されない。公開操作は修正・検証を終えたリリースに対して実施する。
