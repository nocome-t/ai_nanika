# Ai Nanika

デスクトップにキャラクターを表示して、OpenAI API と会話する Electron アプリです。

## 使う人向け

1. 配布されたアプリを起動します。
2. 初回起動時、または保存済みの API キーが無効な時は、API キー入力ダイアログが表示されます。
3. 自分の OpenAI API キーを入力します。
4. API キーが確認できると、会話できるようになります。

API キーはアプリ内のローカル保存領域に保存されます。配布ファイルや GitHub には含めません。

## 開発者向け

依存関係を入れます。

```bash
npm install
```

開発起動します。

```bash
npm start
```

配布用の DMG を作ります。

```bash
npm run dist
```

生成物は `dist/` に出力されます。

## GitHub に登録する手順

GitHub を使ったことがない場合は、次の順番で進めると安全です。

1. [GitHub](https://github.com/) でアカウントを作成します。
2. 右上の `+` から `New repository` を選びます。
3. Repository name に `ai_nanika` などの名前を入れます。
4. Public または Private を選びます。配布したい場合は Public が分かりやすいです。
5. `Add a README file` はオフのままにします。このプロジェクトには README が入っています。
6. `Create repository` を押します。
7. 作成後に表示される repository URL を控えます。例: `https://github.com/ユーザー名/ai_nanika.git`

手元のフォルダで次を実行します。

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/ユーザー名/ai_nanika.git
git push -u origin main
```

`.env`、`node_modules/`、`dist/` は `.gitignore` により GitHub へ上がりません。API キーを GitHub に登録しないよう、`.env` やコード内にキーを書かないでください。
