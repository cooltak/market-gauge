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
| プット・コール・レシオ | CBOE（Total） | 1.15以上 |
| VIX | Yahoo Finance `^VIX` | 30超えの高値から下がり始め |
| Fear & Greed | CNN | 25以下 |
| 米10年債利回り | Yahoo Finance `^TNX` | 約1ヶ月で0.30%以上低下 |

「VIX高値から低下」＋「10年債利回り急低下」が同時に出たら 🔥最強シグナル。

判定ロジックは `index.html` の `INDICATORS` にまとまっている（基準値を変えるならここ）。

## 手動でデータ更新

GitHub の Actions タブ → 「Update market data」 → Run workflow
