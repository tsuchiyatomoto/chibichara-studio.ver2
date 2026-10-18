# 音声生成・背景除去の非同期ジョブ

RenderとRunPodの間では推論の完了を待たず、ジョブIDを返す。画面は約1.5秒ごとに
短いHTTPリクエストで状態を取得し、完了後にWAVまたはPNGを別途ダウンロードする。
Web→RunPodの受付・確認には20秒の通信上限を設ける。GPU処理は接続切断後も継続する。

## API

| 処理 | Next.js | ワーカー |
| --- | --- | --- |
| 音声生成の受付 | `POST /api/generate-speech` | `POST /v1/audio/speech-jobs` |
| 音声生成の状態・中止 | `GET/DELETE /api/speech-jobs/{id}` | `GET/DELETE /v1/audio/speech-jobs/{id}` |
| WAV取得 | `GET /api/speech-jobs/{id}/content` | `GET /v1/audio/speech-jobs/{id}/content` |
| 画像生成→背景除去受付 | `POST /api/generate-image` | `POST /jobs` |
| 背景除去の状態・中止 | `GET/DELETE /api/image-jobs/{id}` | `GET/DELETE /jobs/{id}` |
| PNG取得 | `GET /api/image-jobs/{id}/content` | `GET /jobs/{id}/content` |

受付は`202`と`{id,status,...}`を返す。画像生成のレスポンスは、画像プロバイダーの
呼び出し終了後に`{job,sourceImage,model,provider,...}`を返す。
表示用の透過PNGは後続の結果取得で返す。ブラウザは共通ヘルパーで以前と同じ
WAV/画像形式に変換するため、試聴やポーズ生成の保存形式は変わらない。

音声・背景除去の旧同期APIはPod内の信頼できる呼び出し用に維持する。
Movieは既存のジョブAPIを使い、内部の音声生成だけ同期TTSを呼ぶ。
追加のRedisや外部キューは使わない。

## 状態・排他・二重受付

`queued → running → completed/failed`を基本とし、中止は
`queued → cancelled`または`running → cancelling → cancelled`になる。
実行中のGPU処理は途中で切り離さず、完了して排他を返すまでジョブを保持する。
中止された処理の結果は公開しない。

音声ジョブは既存TTSの合成セマフォと学習用WorkloadGateを使う。
Speaker Inversionの予約・学習中は待機する。ToonOutは既存のモデルロックを使う。
各サービスのワーカーは1プロセス・1ジョブキューとし、uvicornのworkersを増やさない。

各受付には`Idempotency-Key`を付ける。同じ所有者・同じキー・同じ入力の再送は
同じジョブを返す。キーを別の入力へ使い回すと`409`になる。
ToonOut受付の一時的な通信失敗は、同じキーを使って最大3回再送する。
既定で処理待ちは全体64件・所有者ごと8件までとし、超えると`429`を返す。

## 保存・所有者

ローカルではTTSランチャーがリポジトリ直下の`.speech-jobs/`を使う。
ToonOutは`.toonout-data/jobs/`を使う。Dockerではそれぞれ
`/workspace/data/irodori/speech-jobs/`と`/workspace/data/toonout/jobs/`になる。

入力・状態を原子的なJSONファイルで保存し、生成結果も一時ファイルから置き換える。
音声ジョブの参照音声・声モデルは受付時にジョブ専用ファイルへコピーする。
元の一時音声の期限切れや保存モデルの置換・削除が、受付済みの音声を変えない。
処理終了後は入力・参照コピーを削除し、状態と結果を既定で24時間保持する。

Webは所有者cookieから所有者IDを作り、秘密トークンと一緒にワーカーへ送る。
ジョブIDを知っていても、別の所有者からは取得・中止・ダウンロードできない。
ワーカーの認証情報や内部ファイルパスをブラウザへ渡さない。

## 再読み込み・再起動

ブラウザは`chibichara-generation-jobs` IndexedDBに受付キーとジョブIDを保存する。

- Voiceは、受付済みの学習用サンプルを再読み込み後に取得して復元する。
  残りの文章は従来の「残り○本を生成」から続ける。学習後の試聴は既存の自動生成が
  保留ジョブへ接続し直す。明示的な受付失敗は再読み込み時に勝手に再実行しない。
  完了したWAVは声のセッションへ保存されるまで一時保存する。参照音声の登録だけが
  失敗した場合も、同じWAVを使って登録を再試行できる。
- Avatarは、再読み込み後に同じ設定で生成を再実行すると保留中の背景除去を再利用する。
  完了済みフレームも、ポーズ全体がIndexedDBへ保存されるまで一時保存する。
  そのため途中のフレームからの再開で、完了済みの画像APIを呼び直さない。
- ワーカー再起動では、未実行の`queued`を再開する。実行中だった`running/cancelling`は
  中断エラーにする。GPU処理の途中からの復帰や、同じ推論の自動再実行は行わない。
  完了済みの結果は期限内であれば再取得できる。

画像プロバイダーの生成が終わり、背景除去ジョブの受付情報がブラウザへ保存される前に
通信が切れた場合は、画像生成そのものの復元は保証しない。これはRunPodの推論待ちと
別の区間であり、OpenAI/Vertexへの画像生成は現在もRender側から呼ぶ。

## 更新と検証

ワーカーとWebを同じ変更に更新する。旧ToonOutが起動したままの場合、ジョブ対応を
確認できないため、有料画像生成の前にエラーにする。ローカルでもTTSとToonOutを
再起動する。既存の声・動画データの移動は不要。

```powershell
npm run jobs:test
npm run test:web
```

Irodoriの環境で`gpu/irodori/tests`、Webの環境でVoiceとAvatarのPlaywright設定も実行する。
`LONG_JOB_TEST=1`を設定した`gpu/tests/test_toonout_jobs.py`のテストでは、101秒の
模擬処理中に短い状態確認を継続し、完了後のPNG取得を検証する。
このテストはRunPod実機・実GPU推論の代わりにはならない。
