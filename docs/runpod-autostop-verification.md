# Runpod自動停止の確認

2026-10-20 21:35 JSTに、既存のMovie・Voice・ToonOutを読み取りだけで確認した。追加ジョブの投入、エンドポイント設定変更、手動停止は行っていない。

## 結果

3つとも処理終了後のコンテナ停止ログがあり、確認時のRUNNINGワーカーは0件。自動停止は動作している。

| 役割 | エンドポイントID | 確認時の状態 | 直近のコンテナ停止（JST） |
| --- | --- | --- | --- |
| Movie | 3ijzfxx876zwfa | IDLE 1 / RUNNING 0 | 21:16:23 |
| Voice | 7iz75uwsux8sbm | INITIALIZING 1 / RUNNING 0 | 21:11:22 |
| ToonOut | lztjqri9wp5j56 | IDLE 1 / RUNNING 0 | 21:09:07 |

証拠はRunpod MCPのget-endpoint、list-endpoint-workers、endpoint-health、stream-worker-logs（system）。ワーカー一覧は時間を空けて2回取得した。Voiceは最初THROTTLED、最後INITIALIZINGで、どちらもGPU実行前の非課金状態。

systemログにはMovieのstop container（12:16:23Z）とremove container（12:16:26Z）、Voiceのstop container（12:11:22Z）、ToonOutのstop container（12:09:07Z）とremove container（12:09:08Z）が記録されている。過去の手動停止ではなく、直近の正常終了ジョブの後に発生した停止を確認した。

## IDLEの意味の訂正

前の確認ではIDLEを稼働中の待機と扱ったが、これは誤りだった。2026-10-15更新の[公式ワーカー仕様](https://docs.runpod.io/serverless/workers/overview#worker-states)では以下の区分となっている。

| 状態 | 意味 | GPU実行課金 |
| --- | --- | --- |
| INITIALIZING | ホストでイメージ等を事前準備、コンテナ未実行 | なし |
| IDLE | 停止済みで起動可能な状態 | なし |
| RUNNING | 起動・処理・idle timeout中の待機 | あり |
| THROTTLED | ホストGPUに空きがなく起動前 | なし |

ワーカー一覧に行が残っていても、実行中のGPUが残っているとは限らない。停止済みの準備枠を消すために最大ワーカーを0へ変更する必要はない。

## 現在の設定

すべて最小0・最大1、FlashBoot OFF。Voice・ToonOutはQUEUE_DELAY 4秒、idle timeout 60秒。MovieはREQUEST_COUNT 1で、v2 APIではこの組み合わせにidle timeoutを指定しない。

既存ジョブの停止実績を使った確認であり、現在の60秒設定で停止までの秒数を測定する新しいジョブは投入していない。最小0・最大1の設定も変更していない。

## 課金記録の確認範囲

list-billingとlist-serverless-billingを取得した。照会範囲は2026-10-20 09:00〜13:00 UTC（APIの時間単位への丸めを含む）。返却された記録の最新終了時刻は12:00 UTCで、直近のVoice・ToonOut・Movie連携確認の利用額はまだ揃っていない。

| 種類 | APIに反映済みの金額（USD） |
| --- | ---: |
| Pods | 0 |
| Serverless | 0.04950289987027645 |
| Public Endpoints | 0 |
| Network volumes | 0 |
| Clusters | 0 |
| その他ストレージ | 0 |
| 合計 | 0.04950289987027645 |

反映済みのServerless金額はMovie（3ijzfxx876zwfa）の実行分。Voice・ToonOutは返却された課金行が0件だった。これは直近の利用が無料だったことを意味しない。

現在のGPU非課金状態は公式仕様と実際の停止ログ・ワーカー状態で確認できた。一方、直近の実行費用と停止後の請求額の台帳照合は集計反映待ち。利用分全体が0ドル、または今後も費用が発生しないという確認ではない。[公式の課金対象期間](https://docs.runpod.io/serverless/pricing#compute-cost-breakdown)も参照。
