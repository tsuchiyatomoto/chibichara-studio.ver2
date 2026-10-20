# Movieの短期利用向けServerless構成

3人程度が各1回使う検証向け。SQLite WALは削除せず、**1回の変換処理の間だけローカルディスクで使用**する。DBファイルをNetwork VolumeやS3へ転送しない。

## 処理の流れ

1. Next.jsの既存Movie APIが8 MiBずつ動画をS3互換ストレージへ送る。声モデルは既存Irodori APIから取得して固定し、アバターPNGとともに短期保存する。
2. 変換開始時にRunpod `/run`へ素材のmanifestキーだけを送る。APIキー・ストレージキーはブラウザーへ返さない。
3. ワーカーはローカルのジョブ専用ディレクトリに素材を取得し、SQLiteを作る。既存Engineのinspect→analyze（合成・出力を含む）を同期実行する。処理をバックグラウンドへ投げたままhandlerを終了しない。
4. MP4・実況WAVをS3へアップロードし終わってからresult.jsonを公開し、handlerを終了する。成功・例外ともローカル作業領域を削除する。ワーカー強制終了時はコンテナの破棄で消える。
5. Next.jsが署名付きURLへリダイレクトしてダウンロードする。ワーカー停止後も取得可能。URLの有効期限は最長15分、素材・結果のアプリ上の利用期限はアップロード作成から24時間。

一時manifestには進行中の操作に必要な状態と匿名所有者を保持する。永続DBやユーザー別ライブラリは追加しない。匿名所有者チェックは他の利用者のファイルを取得させないため維持する。

## 必須のストレージ設定

**Cloudflare R2の非公開バケットを使用する。** 作成手順・認証情報・24時間削除ルールは [cloudflare-r2.md](cloudflare-r2.md) を参照。Next.jsとワーカーに同じ接続設定を渡す。ブラウザーから直接PUTしないため、アップロード用CORSは不要。

**バケットには `movie-temp/` プレフィックスを1日後に削除するLifecycleルールを必ず設定する。** アプリの24時間期限切れはアクセス制御であり、物理削除の代わりではない。R2のLifecycle削除は非同期で、通常はオブジェクトの有効期限から24時間以内に行われる。途中で失敗したアップロードもこのルールで回収する。

Dashboardから設定するか、`npm --prefix web run r2:configure` でMovie用のルールを設定する。スクリプトは既存の他のルールを残し、適用後に読み直して確認する。必要な管理用認証情報はR2手順書を参照。

接続用トークンは対象R2バケットのObject Read & Writeに限定する。R2は条件付きPutObject（If-Match/If-None-Match）、署名付きGetObject、Rangeリクエストに対応する。更新競合時は409を返す。

## Render / Next.js

```dotenv
MOVIE_BACKEND=runpod
RUNPOD_MOVIE_ENDPOINT_ID=...
RUNPOD_API_KEY=...
MOVIE_S3_BUCKET=chibichara-movie-temp
MOVIE_S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
MOVIE_S3_REGION=auto
MOVIE_S3_ACCESS_KEY_ID=...
MOVIE_S3_SECRET_ACCESS_KEY=...
MOVIE_S3_FORCE_PATH_STYLE=true
```

R2のエンドポイントはバケット画面のS3 APIエンドポイントを指定する。既存の `IRODORI_TTS_BASE_URL` と `IRODORI_TTS_API_KEY` も必要。保存済み声モデルを取得できる既存Voice APIを指す。

`MOVIE_BACKEND` を未設定にすると既存のHTTP Movieサーバーを使用する。ローカル起動コマンドは変わらない。

## Runpodワーカー

```powershell
docker build -f gpu/Dockerfile.serverless -t <private-registry>/chibichara-movie:<tag> gpu
```

既存のGPUイメージをベースにした追加イメージ。ローカル検証済みイメージから作る場合は `--build-arg BASE_IMAGE=chibichara-gpu:local` を指定できる。公開時は検証済みベースイメージのdigestを固定する。

環境変数は `gpu/docker/serverless.env.example` を参照。既存bootstrapが3サービス用トークンを検証するため、Movieキューワーカーでも3つを設定する。実際に起動するのはMovie handlerと同一コンテナ内のIrodoriのみ。外部HTTP公開は不要。ToonOutを起動せず余分なGPUメモリ使用を避ける。

- Queue-based endpoint、REQUEST_COUNT（1件/worker）、最小ワーカー0、最大1、handler同時実行1。
- CUDA 12.8以上。GPU・ローカルディスク容量は実際のモデルと入力サイズに合わせる。
- 例としてジョブ実行上限2時間、キューを含むTTL6時間を送信する。実動画の計測に応じて調整する。
- モデルキャッシュにNetwork Volumeを使う場合も、`MOVIE_LOCAL_TMP` と `MOVIE_DATA_DIR` はローカルのままにする。
- ストレージとGeminiの認証はワーカー側にも必要。

## 検証時の制限

- この追加実装はMovie変換のServerless化。Voiceの学習APIとToonOutのServerless移行は含まない。既存Voiceサービスから声モデルを取得できる構成が前提。
- Serverlessモードでは1回の変換を実行し、再編集・途中再開・再生成は動画の再アップロードで行う。既存HTTPモードの再編集APIは変更しない。
- ページを再読み込みすると、変換前のローカル動画プレビューは失われる。完成後の動画はS3から再生・ダウンロードできる。
- `/run`送信の通信切断は「受付されたか不明」になり得るので自動再送しない。ワーカーが起動するとreceiptを保存し、結果の取得を復旧できる。受付自体が失敗した場合は運用側でキューを確認してから再アップロードする。
- 途中でワーカーが失われた場合の変換再開は実装しない。Runpodの失敗状態を表示する。
- 実R2へのストレージ接続とLifecycle設定、Runpodでの6秒動画の実変換・ダウンロードは確認済み。長時間動画や複数ユーザーを通したブラウザー操作の検証は別途行う。

## ローカルでの確認記録

2026-10-19に、Web/Pythonのユニットテストに加え、Moto 5.1.16のS3互換HTTPエミュレーターで、Node AWS SDK→保存→Docker内のPython boto3→結果保存→署名付きダウンロードを確認した。条件付き更新、他の匿名所有者からの取得拒否、HTTP Range（206）、削除も確認済み。SQLite WALはローカルで作成し、処理終了後に作業ディレクトリが空になること、S3へSQLiteを送らないことを確認した。

この接続テストでは変換本体・声モデル検証・Runpod APIをテスト用に置き換えた。ワーカーコンテナを削除した後も完成結果とダウンロードを取得できた。実ストレージプロバイダー、Runpodのジョブ実行、ASR/Gemini/TTSを含むフル変換の検証を代替するものではない。

同日、Cloudflare R2の実バケットでも確認した。Webの実ストレージ関数で8MiBの保存・取得、条件付き更新、署名付きダウンロード、Range取得（206）、匿名アクセス拒否、削除が成功した。さらにWebが保存した10MiBをDocker内のMovieワーカーの実Python関数で取得し、boto3のmultipart uploadで書き戻した。コンテナ終了後もWebから結果を取得でき、検証用のローカル一時ファイルとR2オブジェクトは削除済み。Runpodと動画変換処理はこの試験に含めていない。設定と検証の詳細は [cloudflare-r2.md](cloudflare-r2.md) を参照。

## 公開済み構成と検証結果（2026-10-20）

検証済みイメージを既存の非公開GHCRパッケージへ公開した。

```text
ghcr.io/tsuchiyatomoto/chibichara-gpu:v0.2.1-movie-serverless-20261020
sha256:88114ec1fac6a231602503da78cc3ada6e2b255fdd02c4981ddeb525fa642320
```

GHCRからmanifestを読み直し、digestとLinux/amd64対応を確認した。パッケージのvisibilityはprivate、匿名取得は401。MovieワーカーとServerless起動スクリプト計13ファイルが現在のソースと一致し、ローカルの環境ファイルを含まないことも確認済み。

RunpodはQueue方式、`AMPERE_24`プールのRTX A5000 / L4、CUDA 12.8以上、GPU 1枚、最小ワーカー0・最大1、コンテナディスク100GB、Network Volumeなし。公開したイメージのdigestを固定し、R2キーとGoogle認証などはRunpod Secretsを参照する。2026-10-20のRunpod GPUカタログ読み取りでは、このプールのServerless料金はワーカー稼働1時間相当0.69 USD。

`RUNPOD_API_KEY` を `web/.env.local` に設定し、実APIで認証を確認済み。Runpodに秘密情報6件とGHCR認証 `cmverqezl00d412dcligxlpjq` を登録し、メタデータを読み直した。非公開Serverlessテンプレート `f6dpzab2vt`（`chibichara-movie-serverless-20261019`）も作成し、イメージ・ディスク100GB・認証参照・外部公開ポートなしを確認済み。

エンドポイントは `3ijzfxx876zwfa`（`chibichara-movie-prototype`）、API URLは `https://api.runpod.ai/v2/3ijzfxx876zwfa/run`。作成・イメージ更新後に設定を読み直し、非公開イメージのdigest・認証参照・外部公開ポートなし・Network Volumeなしを確認した。

6秒・音声2トラックのMP4、アバター画像、既存のテスト用speaker embeddingで実変換を行った。最初の試験で、ダウンロードした声モデルのハッシュを合成エンジンに渡していない不具合を発見し、v0.2.1で修正した。実合成エンジンの照合処理を呼ぶ回帰テストを追加し、Serverless関連11テストが成功した。

修正版のジョブ `b9473e00-0afe-4ad9-bbf6-e13ce069d6a3-u1` は `COMPLETED`。EUR-IS-1のL4で、ASR→Gemini→CUDA/FP32の音声合成→MP4の書き出し→R2保存まで成功した。初回のキュー待ちは370,219ms、処理は155,219ms（モデル取得を含む）。短い動画でも初回起動は数分かかる。

Web側の実ストレージ関数とMovie API関数で、6秒のMP4（49,030 bytes）と音声（576,044 bytes）の署名付きダウンロード、Range取得（206）、他の匿名所有者からの拒否（404）、SQLiteがR2へ送られていないことを確認した。合成済みセグメントは1/1件。ワーカー上限を0にした後も、Runpod APIキーを外して完成結果と両ファイルをR2から取得できた。検証用R2ファイルは削除し、出力のローカルコピーをGit管理対象外の `.diagnostics/runpod-movie-smoke/` に保存した。

現在の設定は最小0・最大1、REQUEST_COUNT=1、FlashBoot OFF。v2 APIではこの組み合わせにidle timeoutを指定しない。初期確認ではIDLEを稼働中の待機と解釈して設定を調整したが、公式仕様ではIDLEは停止済み・非課金であり、この解釈を訂正した。2026-10-20 21:35 JSTに直近の正常終了ジョブの後のstop container / remove containerログとRUNNING 0を確認し、自動停止を検証済み。直近の実行費用の台帳照合は集計反映待ち。[自動停止の確認結果](runpod-autostop-verification.md)を参照。

アプリからジョブを送るAPIキーはMCPのOAuth接続とは別に必要。キーやGoogle認証、R2キーはチャットやGitには載せない。ローカルのデプロイ記録もGit管理対象外に保存している。Web側は `RUNPOD_MOVIE_ENDPOINT_ID` と `MOVIE_BACKEND=runpod` を設定する。Render側の環境変数設定・公開、Voice学習とToonOutの遠隔化はこのMovieワーカーのデプロイに含まない。
