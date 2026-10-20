# Renderへのデプロイ

2026-10-20にNext.jsをRenderへ公開した。

- アプリ: https://chibichara-studio-prototype.onrender.com
- 管理画面: https://dashboard.render.com/web/srv-dbbmc0jncjis7397dbfg
- サービス名: `chibichara-studio-prototype`
- リージョン: Singapore
- プラン: Free

## ビルド・起動設定

| 項目 | 値 |
| --- | --- |
| リポジトリ | `tsuchiyatomoto/chibichara-studio.ver2` |
| ブランチ | `main` |
| Root Directory | `web` |
| Runtime | Node |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run start -- --hostname 0.0.0.0` |
| Health Check Path | `/` |
| 自動デプロイ | `main`へのpush |

起動スクリプトはRenderが渡す`PORT`を使う。Nodeのメジャーバージョンは環境変数`NODE_VERSION=24`で指定した。

## 環境変数

以下の16項目をRenderへ登録し、保存後の読み戻しで一致を確認した。秘密値はリポジトリに保存しない。

```text
OPENAI_API_KEY
RUNPOD_API_KEY
RUNPOD_MOVIE_ENDPOINT_ID
RUNPOD_VOICE_ENDPOINT_ID
RUNPOD_TOONOUT_ENDPOINT_ID
MOVIE_BACKEND=runpod
VOICE_BACKEND=runpod
TOONOUT_BACKEND=runpod
MOVIE_S3_BUCKET
MOVIE_S3_ENDPOINT
MOVIE_S3_REGION
MOVIE_S3_ACCESS_KEY_ID
MOVIE_S3_SECRET_ACCESS_KEY
MOVIE_S3_FORCE_PATH_STYLE
NODE_VERSION=24
NEXT_TELEMETRY_DISABLED=1
```

Voice・ToonOut・MovieのGPU処理は既存のRunpod Serverlessへ送る。進捗と結果はR2を使い、Renderのローカルディスクには依存しない。動画と処理用一時ファイルは既存の24時間失効・削除設定を使う。

## 公開環境で確認した範囲

- `/`、`/voice`、`/avatar`、`/movie`の表示。
- Voice・MovieのRunpod接続用ヘルスチェック。
- 8 MiBの動画アップロード用データをRender経由でR2へ保存し、完了処理と削除。
- 別のブラウザーからのジョブ取得が404になること。
- Voiceの音声生成完了と、ブラウザーから同じオリジン経由で4.92秒のWAVを取得。
- OpenAIでの画像生成、ToonOutの処理完了、ブラウザーから1024×1024の透過PNGを取得。

今回のテスト専用R2データ15オブジェクトは削除した。既存の利用者データは変更していない。

初回公開時は`.gitignore`の`speech-jobs/`がAPIソースにも適用され、音声の状態取得が404になった。`web/app/api/speech-jobs/`を例外にしてGitへ追加し、実際のルート経由で取得・キャンセルを検証するテストも追加した。49件のWebテストが成功し、再デプロイ後の公開APIでも取得できた。

公開ビルドで見つかった依存関係の警告を調査し、Next.jsとESLint設定を16.4.2へ更新した。間接依存も対応する修正版へ更新し、`npm audit --omit=dev`は0件。49件のテスト、本番ビルド、ESLintが成功した。開発用依存を含む監査では8件のHighが残っている。

Movieの動画変換と保存済みボイスの連携は、先にローカルNext.jsから実Runpod・R2を使って確認した。今回のRender確認ではMovieの変換ジョブを追加実行していない。3000ステップの学習品質・所要時間も未測定。

## Freeプランの起動待ち

RenderのFree Web Serviceは15分間リクエストがないと休止し、次のアクセス時の起動に約1分かかる。GPU側も停止後の初回処理に起動待ちがある。

- [RenderのFreeプラン仕様](https://render.com/docs/free)
- [Renderのモノレポ設定](https://render.com/docs/monorepo-support)
- [Runpod側の構成](voice-toonout-serverless.md)
