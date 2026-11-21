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
| 米10年債利回り | CBOE・CNBC など | 1ヶ月以内の高値から0.30%以上低下 |

「VIX高値から低下」＋「10年債利回り急低下」が同時に出たら 🔥最強シグナル。

判定ロジックは `index.html` の `INDICATORS` にまとまっている（基準値を変えるならここ。タイトル横の (i) の説明 `HELP` も一緒に直す）。

各カードの「最終更新」は、値が最後に変わった時刻（`data.json` の `changedAt`。`scripts/fetch.mjs` が最新の1点の日付と値を前回と比べて記録する）。

## ディストリビューション／フォロースルー（IBD流）

テクニカル確認の2枚目。S&P500 の終値と **SPY の出来高**（指数そのものの出来高は無料で取れないので代用。取得元は nasdaq.com、予備 Yahoo）で、ブラウザ側で判定する。基準値は `index.html` の `IBD`。

- ディストリビューション・デー（DD）: 前日比 −0.2% を超える下落＋出来高が前日より多い。25営業日か、その日の終値から +5% で数から外れる
- 4〜5個で「警戒」、6個で「調整入り」（**ゲージ独自の目安**。IBD は裁量で判断している）
- フォロースルーデー: 調整中に、反発の試みの4日目以降で +1.25% 以上＋出来高増 → 点灯（上昇トレンド入りの確認）。反発の安値を割ったら失敗（消灯）
- 定義は二次情報（IBD 公式の原文は未確認）。出来高を SPY で代用するので、IBD の公式の数とはずれることがある。フォロースルーの成功率は検証で約5割（Hanna 2008）

## 米国の休場日

`index.html` の `NYSE_HOLIDAYS` / `NYSE_EARLY_CLOSE`（NYSE 公式の表。掲載は2028年まで）。休場日は「休場」、短縮取引日は13:00で閉場と表示する。2029年以降は NYSE が発表したら書き足す。
時報係は休場日も合図を送るが、データが変わらないので何も書き込まれない（害も費用もないので、そのままにしている）。

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
