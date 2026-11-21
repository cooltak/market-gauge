# 買い場ゲージ

プット・コール・レシオ / VIX / Fear & Greed Index / 米10年債利回り を1画面で確認し、
「買い場サイン」を自動判定するWebアプリ。

## しくみ

```
GitHub Actions（30分ごと） → scripts/fetch.mjs → data.json をコミット
                                                     ↓
                              GitHub Pages の index.html が読み込んで表示
```

| 指標 | 取得元 | 買い場サイン |
|---|---|---|
| プット・コール・レシオ | CBOE（Total） | 1.1以上 |
| VIX | Yahoo Finance `^VIX` | 30超えの高値から下がり始め |
| Fear & Greed | CNN | 25以下 |
| 米10年債利回り | Yahoo Finance `^TNX` | 約1ヶ月で0.30%以上低下 |

「VIX高値から低下」＋「10年債利回り急低下」が同時に出たら 🔥最強シグナル。

判定ロジックは `index.html` の `INDICATORS` にまとまっている（基準値を変えるならここ）。

## 自動更新のしくみ（時報係）

GitHub の定期実行は抜けが多いため、個人サーバー **sos-new（Vultr）** の cron から
10分ごとに `workflow_dispatch` で起動している。

- スクリプト: `~/market-gauge-trigger.sh`（NY時間の平日 9:20〜16:30 と 18:00 だけ合図を送る）
- 鍵: `~/.market-gauge-token`（fine-grained PAT。market-gauge の Actions 書き込みのみ。**期限 2027-11-20**）
- cron: `*/10 * * * * sh $HOME/market-gauge-trigger.sh >/dev/null 2>&1`
- 止めるとき: `crontab -e` でこの1行を消す
- 鍵を作り直したら、サーバーの `~/.market-gauge-token` を差し替え、`index.html` の `TOKEN_EXPIRES` も更新する

GitHub 側の `schedule` は予備として残している。

## 手動でデータ更新

GitHub の Actions タブ → 「Update market data」 → Run workflow
