# Cloudflare R2：Movieの24時間保存

R2の非公開バケットを1つ使う。入力動画・アバター・声モデル・完成MP4・処理状態を `movie-temp/` 配下に置き、1日で削除するLifecycleルールを適用する。SQLiteはRunpod内のローカル一時領域だけに置く。

## 1. バケットを作成

1. [CloudflareのR2画面](https://dash.cloudflare.com/?to=/:account/r2/overview)でR2を有効化する。
2. バケット名を `chibichara-movie-temp`、ストレージクラスを **Standard** にして作成する。別の名前にした場合は以下の設定も合わせる。
3. 公開用の `r2.dev` とカスタムドメインは有効にしない。ダウンロードにはS3 APIの署名付きURLを使う。
4. バケットのSettingsにあるS3 APIエンドポイントとアカウントIDを確認する。

## 2. 1日で削除するルール

バケットの **Settings → Object Lifecycle Rules → Add rule** で設定する。

| 項目 | 値 |
| --- | --- |
| Rule name | `chibichara-movie-delete-after-24h` |
| Prefix | `movie-temp/` |
| Delete objects | 1日後 |
| Abort incomplete multipart uploads | 1日後 |

アプリはアップロードの作成から24時間で動画取得を停止し、署名付きURLの有効期限もこの期限を超えないようにする。R2の削除ルールは**各オブジェクトのR2への保存時刻**を基準にする。R2の削除処理は非同期で、通常は有効期限から24時間以内に実行されるため、**24時間ちょうどに物理削除される保証はない**。また、解析後に保存される完成動画と入力素材では削除時刻が異なる。[R2の公式仕様](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

## 3. 接続用のキーを作成

R2のManage API Tokensから、対象バケットに限定した **Object Read & Write** のトークンを作り、表示されたAccess Key IDとSecret Access Keyを控える。キーはチャットに貼らず、RenderとRunpodの環境変数に保存する。

両方に以下を設定する。エンドポイントはバケット画面の値を使う。通常は下記の形式で、バケット名を末尾に追加しない。

```dotenv
MOVIE_S3_BUCKET=chibichara-movie-temp
MOVIE_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
MOVIE_S3_REGION=auto
MOVIE_S3_ACCESS_KEY_ID=...
MOVIE_S3_SECRET_ACCESS_KEY=...
MOVIE_S3_FORCE_PATH_STYLE=true
```

Renderには追加で `MOVIE_BACKEND=runpod`、`RUNPOD_MOVIE_ENDPOINT_ID`、`RUNPOD_API_KEY` を設定する。`web/.env.example` と `gpu/docker/serverless.env.example` に設定例を用意している。ブラウザーからのアップロードはNext.jsを経由するため、R2へのアップロード用CORSは不要。

## 任意：スクリプトでルールを設定・確認

Dashboardで設定する代わりに、Cloudflare REST APIを使うスクリプトも使用できる。既存のLifecycleルールを取得し、Movie用のルールだけを追加・更新して、設定後に読み直す。バケット作成は行わない。

Cloudflareの **Workers R2 Storage Write** 権限を持つ管理用APIトークンを、ローカルの `web/.env.local` に設定する。このトークンは上記のオブジェクト操作用キーとは用途が異なり、RenderやRunpodには不要。

```dotenv
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
MOVIE_S3_BUCKET=chibichara-movie-temp
```

```powershell
# 現在のルールを確認（変更しない）
npm --prefix web run r2:check
# Movie用の24時間削除ルールを適用し、読み直して確認
npm --prefix web run r2:configure
```

手順2でDashboardから設定した場合は、この管理用トークンは必要ない。稼働前に実R2で小さな動画を処理し、ワーカー停止後のダウンロードまで確認する。

参照：[R2の認証](https://developers.cloudflare.com/r2/api/tokens/)、[S3 APIの互換性](https://developers.cloudflare.com/r2/api/s3/api/)、[Lifecycle設定API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/)。

## 実環境の設定記録（2026-10-19）

Cloudflare MCPで `chibichara-movie-temp` を作成し、設定後にAPIから読み直して次を確認済み。

- ストレージクラス：Standard、配置：APAC。
- 公開アクセス：`r2.dev` は無効、カスタムドメインなし。
- `movie-temp/` 配下のオブジェクト削除：保存から86,400秒後。
- 同プレフィックスの未完了multipart upload：開始から86,400秒後に中止。
- 既存の標準multipart削除ルールは保持。

今回のMCP認証にはAPIトークン管理の権限がなく、接続用S3キーは手順3の画面操作で発行した（Cloudflare APIエラー9109を確認）。入力されたキーを `web/.env.local` と `gpu/.env.local` に設定し、実R2への通信も確認済み。キーはGit管理対象外で、検証ログにも出力していない。

- Next.js側の実ストレージ関数で8MiBをアップロードし、内容の一致、一覧取得、条件付き更新と競合拒否を確認。
- 署名付きURLの有効期限、ダウンロード、Range取得（206）、署名なしアクセスの拒否を確認。
- Docker内のMovieワーカーの実Python関数で、Webが保存した10MiBを取得し、チェックサムを確認。boto3のmultipart uploadで結果を書き戻した。
- テスト用コンテナ終了後、Web側から結果とファイルを取得できることを確認。Pythonの一時ファイルとR2上のテストファイルは削除済み。
- Lifecycleの86,400秒設定と公開アクセス無効をMCPで再取得して確認。24時間経過後の自動削除を待つ試験は行っていない。

この検証は実R2とのファイル通信を対象とする。Runpodでのジョブ実行と、ASR/Gemini/TTSを含む実動画変換は未確認。
