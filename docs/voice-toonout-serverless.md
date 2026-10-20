# Voice・ToonOutのRunpod Serverless

Next.jsはRenderに置き、Voice、Movie、ToonOutはそれぞれQUEUE型のRunpodエンドポイントで処理する。外部からGPUコンテナのHTTPポートに接続する必要はない。

## 接続

Render / web/.env.local に以下を設定する。値はブラウザーに公開しない。

    VOICE_BACKEND=runpod
    TOONOUT_BACKEND=runpod
    RUNPOD_VOICE_ENDPOINT_ID=...
    RUNPOD_TOONOUT_ENDPOINT_ID=...
    RUNPOD_API_KEY=...

R2はMovieと同じ MOVIE_S3_* の6項目を使用する。MOVIE_BACKEND=runpod とMovieのエンドポイントIDも既存通り設定する。

VOICE_BACKEND / TOONOUT_BACKEND を設定しなければ、従来のローカルHTTPサーバーに接続する。

## GPUコンテナ

gpu/Dockerfile.serverless は3役で共用できるprivateイメージ。エンドポイントのテンプレート環境変数 SERVERLESS_ROLE=voice または toonout で役を選ぶ。未設定は既存のMovie。

VoiceはIrodori専用Python環境、ToonOutはToonOut専用Python環境を使う。モデルの精度や既存の学習設定は維持し、Speaker Inversionは既定で3000ステップ。GPU数は1、同時実行は1、最小ワーカー0、最大ワーカー1、待機時間60秒から開始する。

各ジョブが専用のローカル一時ディレクトリとローカルAPIプロセスを持つ。Voiceの学習・音声生成、ToonOutの非同期処理が終了し、出力のR2アップロードが終わるまでRunpodハンドラーは終了しない。子プロセス群の終了と一時ディレクトリの削除後に完了情報を公開する。キャンセルはR2のマーカーで検出し、学習子プロセスも終了する。

モデルのキャッシュはワーカー内の一時ディスク。Network Volume、共有SQLiteは使わない。ワーカー交換後はモデルの再取得が必要で、初回のイメージ取得・モデル準備には数分かかる場合がある。

## R2の保存

| プレフィックス | 内容 | 保存 |
| --- | --- | --- |
| movie-temp/services/{owner}/speech/ | 試聴入力、WAV、状態 | 作成から24時間 |
| movie-temp/services/{owner}/training/ | 学習サンプル、未保存の埋め込み、進捗 | 作成から24時間 |
| movie-temp/services/{owner}/image/ | 入力画像、透過PNG、状態 | 作成から24時間 |
| movie-temp/services/{owner}/assets/ | 基準音声 | 作成から24時間 |
| voice-assets/{owner}/{assetId}/ | 明示的に保存したマイボイス | ユーザーが削除するまで |

movie-temp/ の既存R2ライフサイクルルールが一時ファイルにも適用される。アプリは24時間経過後の取得を拒否する。R2での物理削除は非同期。保存したマイボイスは動画の24時間削除とは別で、従来の保存操作を維持する。

音声モデルを試聴やMovieで使う時点でジョブ専用プレフィックスへコピーするため、その後マイボイスを削除しても実行中ジョブの入力は変わらない。保存・一覧・削除・完了結果の取得には稼働中のVoiceワーカーは不要。

ブラウザーのHTTP Only cookieで利用者を区別する。別のブラウザーやcookie削除後は以前のマイボイスにアクセスできない。今回の検証用URLは参加者に限定して共有する。

## 再送・異常終了

音声生成は所有者とIdempotency-Keyから固定ジョブIDを作り、R2の条件付き書き込みで送信を1回に制限する。学習も同じキーを指定すれば同じ動作。送信の応答を失った場合は自動再送せず、ワーカー自身が書く受領情報から復旧する。ワーカーの重複配送もR2の条件付き書き込みでGPU処理を重複させない。

進捗と完了結果はR2へ保存し、Runpodが失敗・タイムアウトした場合もWeb APIが終了状態に変換する。送信が受理されたか不明でワーカーも始まっていない場合は待機状態が残るため、Runpod側のジョブ一覧を確認する。

## 検証

    cd web
    npm test
    npm run build

PythonテストはMovie依存関係の入った環境で python -m pytest gpu/tests/test_service_serverless.py gpu/tests/test_movie_serverless.py を実行する。

GPUでの実確認は、学習 → 保存 → 保存した声での試聴 → Movieへの読み込み、およびToonOutのRGBA PNGを対象にする。短縮学習は配線の確認であり、3000ステップの学習品質・所要時間の測定とは分けて記録する。

## 2026-10-20のデプロイ・実確認

| 役割 | エンドポイントID | テンプレートID |
| --- | --- | --- |
| Voice | 7iz75uwsux8sbm | euogwwu4si |
| ToonOut | lztjqri9wp5j56 | xnp5wt9t85 |

privateイメージは ghcr.io/tsuchiyatomoto/chibichara-gpu:v0.3.0-services-serverless-20261020、固定digestは sha256:7568d0200a5ab0f9b97689799384d1609d96eccb655c9d3f3dba108ef2f524f3。認証ありの取得と匿名アクセス拒否を確認済み。

実GPUで2ステップの学習、R2への保存、保存した声による4.72秒のWAV生成、透明部分を持つRGBA PNGの生成を確認した。同じ声をMovieに渡し、音声付き6秒MP4の生成とダウンロードまで確認した。学習設定は確認後に3000ステップへ戻し、設定を再取得して確認済み。3000ステップの学習品質と処理時間は未測定。

本番ビルドをローカル起動し、ChromiumからVoice・ToonOutの結果取得、マイボイス一覧、学習の保存状態、Movieの完了状態を確認した。別のブラウザーからの結果取得は404。小さい音声・画像はNext.jsから直接返すため、ブラウザーのfetchにR2のCORS設定は不要。完成ファイルの取得にはRunpod APIキーも不要。

2026-10-20のRunpodカタログで24GBプールは1ワーカー毎時0.69米ドル相当。最小0・最大1・待機60秒を設定した。21:35 JSTの再確認では3役ともコンテナ停止ログとRUNNING 0を確認した。公式仕様のIDLEは停止済み・非課金で、以前の「待機ワーカーが残っているため停止未確認」という解釈を訂正した。直近の利用費用の台帳照合は集計反映待ち。[自動停止の確認結果](runpod-autostop-verification.md)を参照。Renderへの公開はまだ行っていない。
