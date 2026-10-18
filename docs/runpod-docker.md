# RunPod用Docker構成

`gpu/`をビルドコンテキストにし、Irodori-TTS・Movie・ToonOutを1つの
Linuxコンテナで動かす。Next.jsは含めず、Renderの`web/`から各APIへ接続する。

## イメージの構成

| サービス | 公開ポート | Python環境 | 用途 |
| --- | --- | --- | --- |
| Irodori-TTS | 8088 | `/opt/venvs/irodori` | 音声合成・Speaker Inversion |
| Movie | 8090 | `/opt/venvs/movie` | CPUでのASR・解析・動画出力 |
| ToonOut | 8091 | `/opt/venvs/toonout` | CUDAでの背景除去 |

CUDA 12.8.1・Ubuntu 24.04・Python 3.12を使う。Irodoriは既存の`uv.lock`、
MovieとToonOutは`gpu/docker/requirements-*-linux.txt`で依存を固定する。
MovieにはCPU版PyTorchを入れ、CUDA版を使う2サービスとは環境を分ける。

Supervisorが3プロセスを監視・再起動する。MovieはIrodoriのAPI応答を待って
起動し、停止時はMovieを先に終了する。TiniがPID 1としてシグナルと子プロセスを
管理する。標準出力・標準エラーはコンテナログに集約する。

Speaker Inversionに必要な`train.py`と`configs/`は、`irodori/uv.lock`にある
Irodori-TTSのGitコミットをビルド時に取得して`/opt/irodori-training`へ保存する。
実行時にuvキャッシュや移動前のWindowsフォルダへ依存しない。

モデル重み、動画、声モデル、`.env`、認証情報はイメージに含めない。
Hugging Faceのモデルは初回利用時にダウンロードし、永続領域へキャッシュする。
ToonOutは起動時にモデルをロードするため、初回のAPI起動には時間がかかる。
Irodoriは既定で最初の音声生成時にロードする。

## ビルド

LinuxコンテナをビルドできるDocker環境で、リポジトリ直下から実行する。
GPUはビルド時には不要で、実行時に必要になる。

```powershell
docker build --platform linux/amd64 -t chibichara-gpu:local ./gpu
```

CUDA対応ライブラリを2環境へ入れるため、ビルドには大きな空きディスク容量と
時間が必要。ビルド中に各環境の主要モジュールをimportして、依存の欠落を検査する。
CUDAベースイメージはダイジェスト、uvはバージョンで固定している。

Linux向けロックを更新する場合は、uv 0.13.1で次を実行して差分を確認する。
Windowsの仮想環境を`pip freeze`した結果でLinux用ロックを上書きしない。

```powershell
uv pip compile gpu/movie_worker/requirements.txt --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --torch-backend cpu --no-header --no-annotate --output-file gpu/docker/requirements-movie-linux.txt
uv pip compile gpu/docker/requirements-toonout.in --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --torch-backend cu128 --no-header --no-annotate --output-file gpu/docker/requirements-toonout-linux.txt
```

## ローカルでのDocker起動

既存のローカルサーバーとポートが重ならないよう、停止してから実行する。
既存のPowerShell起動方法は引き続き利用できる。

```powershell
Copy-Item gpu/docker/.env.example .env.runpod
```

`.env.runpod`の3つのトークンを別々のランダムな値にする。未設定の場合は起動を
中断する。Movie用のGoogle Cloud設定も入力する。ローカルの`gpu/.env.local`は
Windowsのパスを含むため、そのままDockerへ渡さない。

```powershell
docker run -d --name chibichara-gpu --gpus all --shm-size 2g --stop-timeout 1200 --env-file .env.runpod --mount type=volume,source=chibichara-gpu-data,target=/workspace -p 127.0.0.1:8088:8088 -p 127.0.0.1:8090:8090 -p 127.0.0.1:8091:8091 chibichara-gpu:local
docker logs -f chibichara-gpu
```

起動後のAPI検査:

```powershell
docker exec chibichara-gpu python3 /opt/chibichara/docker/healthcheck.py
docker inspect --format '{{.State.Health.Status}}' chibichara-gpu
```

3つのAPIとMovie→Irodoriの接続を検査する。モデルを使った生成・学習、Google API、
保存済みの声の有無はこの検査の対象外。初回モデル取得の猶予としてDockerの
ヘルスチェック開始期間を30分にしている。

## RunPodへの配置

1. ビルドしたイメージに自分のレジストリのタグを付けてpushする。
2. **GPU Pod**のテンプレートで、そのイメージを指定する。Serverless用の構成ではない。
3. CUDA 12.8に対応するGPU環境を選ぶ。3プロセスは同じGPUメモリを共有するので、
   音声生成・学習・背景除去を組み合わせた実測でVRAMを確認する。
4. `/workspace`へVolume Diskを割り当てる。
5. Expose HTTP Portsに`8088,8090,8091`を設定する。
6. `gpu/docker/.env.example`の環境変数をテンプレートへ設定する。トークンや
   Googleの認証JSONにはRunPod Secretsを使う。
7. イメージ既定のEntrypointを使って起動し、3つのAPIの応答とコンテナログを確認する。

タグ付けとpushの例（レジストリへのログインは事前に行う）:

```powershell
docker tag chibichara-gpu:local YOUR_REGISTRY/chibichara-gpu:VERSION
docker push YOUR_REGISTRY/chibichara-gpu:VERSION
```

独自イメージとポート設定の詳細は[RunPod公式のテンプレート手順](https://docs.runpod.io/pods/templates/create-custom-template)
および[ポート公開手順](https://docs.runpod.io/pods/configuration/expose-ports)を参照。

## 永続領域と認証

```text
/opt/chibichara/                       イメージ内のコード
/opt/venvs/{irodori,movie,toonout}/     独立したPython環境
/opt/irodori-training/                 固定した学習用ソース
/workspace/data/movie/                SQLite・動画・声スナップショット
/workspace/data/toonout/              ToonOutの実行データ
/workspace/data/irodori/voices/        固定の参照音声
/workspace/data/irodori/voice-assets/  保存済み声モデル・一時音声
/workspace/data/irodori/speaker-inversion-jobs/
/workspace/data/irodori/speech-jobs/    音声生成ジョブ・WAV
/workspace/cache/                     モデルキャッシュ
/workspace/tmp/                       一時ファイル
/run/chibichara/                       実行時のみの認証ファイル
```

Movieは声スナップショットの絶対パスをIrodoriへ渡す。同じコンテナ内では同じ
`/workspace/data/movie/`を参照するため、共有が成立する。

この構成は単一PodのローカルVolume Diskを前提とする。Volume Diskは停止・再起動を
越えて保持されるが、Pod削除で消える。保存済みの声などは別途バックアップする。
Network Volumeを使う場合は、MovieのSQLite WALとファイルロックに対応する保存方式を
先に検討する。SQLite WALはネットワークファイルシステムを前提にできない。
[RunPodのストレージ仕様](https://docs.runpod.io/pods/storage/types)、[SQLite WALの制約](https://www.sqlite.org/wal.html)

Googleの認証は次のいずれかを指定する。

- `GOOGLE_SERVICE_ACCOUNT_JSON`: サービスアカウントJSON全体をSecretとして渡す。
  起動時に`/run/chibichara/google-service-account.json`へ権限`0600`で書き込み、
  `GOOGLE_APPLICATION_CREDENTIALS`を設定する。永続領域やイメージには保存しない。
  Dockerの`.env.runpod`に記述する場合は、JSONを1行に圧縮して指定する。
- `GOOGLE_APPLICATION_CREDENTIALS`: あらかじめ配置・マウントした認証ファイルの
  コンテナ内の絶対パスを指定する。

3つのAPIはBearerトークンで保護する。`IRODORI_TTS_API_KEY`は起動時に
`IRODORI_API_KEY`と同じ値を設定するため、内部のMovie→TTS認証にも使える。

## Render側の接続設定

RunPodが発行する各URLをNext.jsのサーバー環境変数へ設定する。

```env
IRODORI_TTS_BASE_URL=https://POD_ID-8088.proxy.runpod.net
IRODORI_TTS_API_KEY=<RunPodのIRODORI_API_KEYと同じ値>
MOVIE_WORKER_URL=https://POD_ID-8090.proxy.runpod.net
MOVIE_WORKER_TOKEN=<RunPodと同じ値>
TOONOUT_WORKER_URL=https://POD_ID-8091.proxy.runpod.net
TOONOUT_WORKER_TOKEN=<RunPodと同じ値>
```

ブラウザはNext.jsのAPIを利用し、上記の秘密トークンを受け取らない。

**標準HTTPプロキシには100秒の待ち時間制限がある。** Voiceの音声生成とToonOutの
背景除去は、ジョブ受付・状態確認・結果取得を分け、受付・確認の各通信を20秒以内で
打ち切る。GPU推論の終了を待つHTTP接続をRender→RunPod間で保持しない。
Movieの長いTTS呼び出しは同じPod内の`127.0.0.1:8088`を使う。
ジョブAPI・復元・保存期限は[非同期ジョブ](async-jobs.md)を参照。
大きな動画の転送時間は別途検証し、既存のチャンク送信・再送・Range取得を利用する。
[RunPodの通信仕様](https://docs.runpod.io/pods/configuration/expose-ports)

## 起動処理のテスト

Dockerを使わず、Python 3.12の標準ライブラリだけで認証・保存先・ヘルスチェック・
起動待ち処理を検証できる。リポジトリ直下から実行する。

```powershell
python -m unittest discover -s gpu/docker/tests -v
```

実イメージのビルドとGPU推論の検証は、DockerとNVIDIA GPUを使える環境で行う。
2026-10-19にローカルPCで実施した起動・HTTP通信・コンテナ再作成後の保存確認は
[Docker起動確認結果](docker-verification.md)を参照。
