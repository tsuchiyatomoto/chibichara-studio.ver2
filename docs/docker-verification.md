# ローカルDocker起動確認（2026-10-19）

WindowsのDocker DesktopでRunPod用イメージをビルドし、GPUを割り当てた単一コンテナで
Irodori・Movie・ToonOutを起動した。3つのAPIが応答し、Dockerのヘルスチェックは`healthy`になった。

## 検証環境

- Docker Engine 29.8.2、Linux/amd64、WSL 2。
- NVIDIA GeForce RTX 3080（10GB）。IrodoriはPyTorch 2.10.0+cu128、ToonOutは2.11.0+cu128でCUDAを認識。
- イメージ：`chibichara-gpu:local`。Docker表示のサイズは約36.3GB。
- イメージID：`sha256:e9a1019f87c7742cb5e6c23e9a3e392447f2e40eccbb46e48f70569b2d1f4eb5`。
- 検証コンテナ：`chibichara-gpu-smoke`。
- 保存ボリューム：`chibichara-gpu-smoke-data`を`/workspace`にマウント。
- 公開ポート：`127.0.0.1:18088`→8088、18090→8090、18091→8091。
- 検証用Next.js：`http://127.0.0.1:13000`。接続先とトークンは検証プロセスの環境変数へ設定。
- 既存の`.movie-data`・`.toonout-data`・音声アセットとは別のデータ領域を使用。
- Hugging Faceの既存モデルキャッシュを検証ボリュームへコピーして起動。

## 確認結果

| 確認内容 | 結果 |
| --- | --- |
| `gpu/Dockerfile`の実ビルド、各Python環境の主要モジュール読み込み | 成功 |
| 3つのAPIの`/health`、Movie→Irodoriの内部通信 | 成功 |
| 認証なしで保護対象APIへアクセス | 401 |
| 音声・画像ジョブを別の所有者で取得 | 404 |
| 同じ入力・Idempotency-Keyの再送 | 同じジョブIDを返す |
| ToonOutの実GPU推論 | 透過RGBA PNG（64×64）を取得 |
| Irodoriの実GPU音声生成 | 「動作確認です。」のWAV（1.88秒）を取得 |
| Next.jsのトップ・Voice・Avatar・Movieページ | HTTP 200 |
| Next.js経由の音声ジョブ受付、WAV/PNGの状態確認・取得 | 成功。直接取得したファイルとSHA-256が一致 |
| コンテナ再起動後のWAV・PNG・音声アセット | 同じSHA-256で取得 |
| コンテナ削除・再作成後のWAV・PNG・音声アセット | 同じボリュームから同じSHA-256で取得 |
| 再作成後のMovieアップロード情報・アップロード済みバイト列 | 保持を確認 |
| 再作成後のMovie SQLite `PRAGMA integrity_check` | `ok` |
| 再作成後のNext.js再接続、Dockerヘルスチェック | 成功、`healthy` |
| Hadolint、`git diff --check` | 成功 |

ジョブ受付はIrodori・ToonOutともに約0.032秒だった。この入力での結果取得までは、
ToonOutが約4.16秒、Irodoriがモデル初期ロードを含め約59秒だった。これらはこのPCでの実測値。

音声アセットの保存確認には、学習結果と同じ保存形式の小さなテスト用safetensorsファイルを使用した。
Speaker Inversionの実学習、MovieのASR・Gemini解析・動画変換、OpenAI/Vertexの画像生成、
Render↔RunPodの通信、RunPodのVolume Disk停止・再起動は今回の検証に含まない。

## ビルド時に修正した点

- Python 3.12で`sentencepiece==0.1.99`をコンパイルするため、`cmake`と`pkg-config`を追加。
- Irodoriの依存ライブラリ導入後に再度`uv sync`すると、`randomname`の古いメタデータを
  削除できず停止した。依存は先に`uv.lock`で導入し、ソースコピー後は
  `uv pip install --no-deps`でサーバー本体だけを追加インストールする形へ変更。

## 現在の状態と確認方法

検証コンテナと検証用Next.jsは起動したままにしてある。検証用トークンと各種結果は、
Git管理対象外の`.diagnostics/`へ保存している。

```powershell
docker exec chibichara-gpu-smoke python3 /opt/chibichara/docker/healthcheck.py
docker inspect --format '{{.State.Health.Status}}' chibichara-gpu-smoke
```

停止する場合：

```powershell
docker stop --timeout 1200 chibichara-gpu-smoke
```

コンテナを削除しても、`chibichara-gpu-smoke-data`ボリュームを削除しなければ検証データは残る。
RunPodへの配置手順は[RunPod用Docker構成](runpod-docker.md)を参照。
