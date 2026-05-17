# Ai Nanika

デスクトップ上にキャラクターを表示し、OpenAI APIを通じて会話を楽しむElectronアプリです。

キャラクターはデスクトップに常駐し、作業の傍らで話しかけたり、会話モードでやり取りしたりできます。

## 主な特徴

- デスクトップ常駐型のAIキャラクターアプリ
- OpenAI APIキーをユーザー自身が設定して利用
- APIキーはローカル保存され、GitHubや配布ファイルには含まれません
- `persona.txt`、`topics.json`、画像ファイルなどでGhostを差し替え可能
- Shell切替、スキンシップ反応、追加表情定義に対応

## 使う人向け

1. 配布されたアプリを起動します。
2. 初回起動時、または保存済みのAPIキーが無効な時は、APIキー入力ダイアログが表示されます。
3. 自分のOpenAI APIキーを入力します。
4. APIキーが確認できると、会話できるようになります。

## APIキーについて

入力したAPIキーはアプリ内のローカル保存領域に保存されます。

GitHubのリポジトリや配布ファイルには含めません。`.env`、`node_modules/`、`dist/` などはGit管理から除外しています。

## 開発者向け

依存関係を入れます。

```bash
npm install
```

開発起動します。

```bash
npm start
```

配布用のDMGを作ります。

```bash
npm run dist
```

生成物は `dist/` に出力されます。

## Ghost Generator

Ghost作成支援用の簡易ジェネレーターも同梱しています。

開発起動:

```bash
npm run start:generator
```

配布用DMG作成:

```bash
npm run dist:generator
```

## 主要ファイル

- `main.js`: Electronのメインプロセス
- `renderer.js`: 会話、UI、Ghost表示、API呼び出しなどのメイン処理
- `index.html`: アプリ画面
- `persona.txt`: 標準Ghostの人格・口調設定
- `topics.json`: 自動発話の話題
- `ghost_*.png`: 表情画像
- `generator-main.js`: Ghost Generatorのメインプロセス
- `generator-renderer.js`: Ghost Generatorの画面処理

## ライセンス

MIT License
