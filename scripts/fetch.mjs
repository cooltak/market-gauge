// 買い場ゲージ: データ取得スクリプト
// GitHub Actions から定期実行され、data.json を更新する。
// 依存パッケージなし（Node 20+ の fetch を使用）。
//
// 取得元:
//   VIX / 米10年債利回り … Yahoo Finance (^VIX / ^TNX)
//   Fear & Greed Index   … CNN
//   プット・コール・レシオ … CBOE 日次マーケット統計
//   SPY の高値・安値・終値・出来高 … nasdaq.com（予備 Yahoo）。ディストリビューション・デー／フォロースルーデー用
//
// 1つの取得元が失敗しても、前回の data.json の値を残して他は更新する。

import { readFile, writeFile } from 'node:fs/promises'

const OUT = new URL('../data.json', import.meta.url)
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers },
  })
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// ニューヨーク時間での日付 (YYYY-MM-DD)
const nyDate = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)

const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n

// ---------- Yahoo Finance ----------
async function yahooSeries(symbol, range = '6mo') {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`
  let json, lastErr
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      json = await getJSON(`https://${host}${path}`)
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!json) throw lastErr
  const r = json?.chart?.result?.[0]
  if (!r) throw new Error(`Yahoo: ${symbol} の結果が空`)
  const ts = r.timestamp || []
  const close = r.indicators?.quote?.[0]?.close || []
  const map = new Map()
  ts.forEach((t, i) => {
    if (close[i] != null) map.set(nyDate(new Date(t * 1000)), close[i])
  })
  // 場中は最新値で当日分を上書き
  const m = r.meta || {}
  if (m.regularMarketPrice != null && m.regularMarketTime) {
    map.set(nyDate(new Date(m.regularMarketTime * 1000)), m.regularMarketPrice)
  }
  const series = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, v]) => ({ d, v: round(v) }))
  return {
    series,
    updatedAt: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
  }
}

// ---------- CBOE 指数（VIX / TNX）----------
// GitHub Actions の IP は Yahoo に 429 で弾かれやすいので、CBOE を第一候補にする
async function cboeSeries(sym, keep = 130) {
  const base = 'https://cdn.cboe.com/api/global/delayed_quotes'
  const hist = await getJSON(`${base}/charts/historical/_${sym}.json`)
  const rows = Array.isArray(hist?.data) ? hist.data : []
  if (!rows.length) throw new Error(`CBOE ${sym}: historical の形式が想定外 keys=${Object.keys(hist || {})}`)
  const map = new Map()
  for (const r of rows) {
    const v = parseFloat(r.close)
    if (r.date && Number.isFinite(v)) map.set(String(r.date).slice(0, 10), v)
  }
  let updatedAt = null
  try {
    const q = (await getJSON(`${base}/quotes/_${sym}.json`))?.data
    const price = parseFloat(q?.current_price)
    const t = q?.last_trade_time
    if (Number.isFinite(price) && t) {
      map.set(String(t).slice(0, 10), price)
      updatedAt = t
    }
  } catch (e) {
    console.warn(`CBOE ${sym} quote: ${e.message}`)
  }
  const series = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-keep)
    .map(([d, v]) => ({ d, v: round(v) }))
  return { series, updatedAt, source: 'CBOE' }
}

// ---------- FRED（米10年債の公式日次データ、1営業日遅れ）----------
async function fredSeries(id, keep = 130) {
  const from = new Date(Date.now() - 600 * 86400000).toISOString().slice(0, 10)
  let res, lastErr
  for (let i = 0; i < 1 && !res; i++) {
    try {
      res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}`, {
        headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
        signal: AbortSignal.timeout(8000),
      })
    } catch (e) {
      lastErr = e
    }
  }
  if (!res) throw new Error(`FRED ${id}: ${lastErr?.cause?.code || lastErr?.message}`)
  if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`)
  const lines = (await res.text()).trim().split('\n').slice(1)
  const series = lines
    .map((l) => l.split(','))
    .filter(([, v]) => v && v !== '.' && Number.isFinite(parseFloat(v)))
    .map(([d, v]) => ({ d, v: parseFloat(v) }))
    .slice(-keep)
  if (!series.length) throw new Error(`FRED ${id}: データ空`)
  return { series, updatedAt: null, source: 'FRED' }
}

async function firstOk(label, fns) {
  const errs = []
  for (const fn of fns) {
    try {
      return await fn()
    } catch (e) {
      errs.push(e.message)
      console.warn(`${label}: ${e.message}`)
    }
  }
  throw new Error(errs.join(' / '))
}

// ---------- CBOE 日次CSV（VIX_History.csv など）----------
async function cboeCsv(sym, keep = 130) {
  const res = await fetch(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${sym}_History.csv`, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
  })
  if (!res.ok) throw new Error(`CBOE CSV ${sym} HTTP ${res.status}`)
  const lines = (await res.text()).trim().split('\n')
  const head = lines.shift().toUpperCase().split(',')
  const ci = head.findIndex((h) => h.includes('CLOSE'))
  const series = lines
    .map((l) => l.split(','))
    .map((c) => {
      const [m, d, y] = c[0].split('/') // MM/DD/YYYY
      return { d: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, v: round(parseFloat(c[ci])) }
    })
    .filter((p) => Number.isFinite(p.v) && /^\d{4}-/.test(p.d))
    .sort((a, b) => a.d.localeCompare(b.d))
    .slice(-keep)
  if (!series.length) throw new Error(`CBOE CSV ${sym}: データ空`)
  return { series, updatedAt: null, source: 'CBOE' }
}

// ---------- Stooq（日次CSV）----------
async function stooqSeries(sym, keep = 130) {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`Stooq ${sym} HTTP ${res.status}`)
  const text = (await res.text()).trim()
  if (!/^Date,/i.test(text)) throw new Error(`Stooq ${sym}: CSVではない応答（${text.slice(0, 80)}）`)
  const lines = text.split('\n')
  const head = lines.shift().split(',')
  const ci = head.findIndex((h) => /close/i.test(h))
  const series = lines
    .map((l) => l.split(','))
    .map((c) => ({ d: c[0], v: round(parseFloat(c[ci]), 3) }))
    .filter((p) => Number.isFinite(p.v) && /^\d{4}-\d{2}-\d{2}$/.test(p.d))
    .slice(-keep)
  if (series.length < 20) throw new Error(`Stooq ${sym}: データ不足`)
  return { series, updatedAt: null, source: 'Stooq' }
}

// ---------- CNBC（最新値のみ。履歴は前回の data.json に継ぎ足す）----------
async function cnbcQuote(sym) {
  const url =
    'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol' +
    `?symbols=${encodeURIComponent(sym)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`
  const json = await getJSON(url)
  const q = json?.FormattedQuoteResult?.FormattedQuote?.[0]
  const v = parseFloat(String(q?.last ?? '').replace(/[^\d.\-]/g, ''))
  const t = q?.last_time
  if (!Number.isFinite(v) || !t) throw new Error(`CNBC ${sym}: 値なし`)
  // last_time は取引所の現地時刻（例 2026-11-20T16:59:00.000-0500）や日付のみで来るので、先頭の日付をそのまま使う
  const d = /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : nyDate(new Date(t))
  const pc = parseFloat(String(q?.previous_day_closing ?? '').replace(/[^\d.\-]/g, ''))
  return { d, v: round(v, 3), t: String(t), pc: Number.isFinite(pc) ? round(pc, 3) : null }
}

function appendPoint(series, q, keep = 130) {
  const map = new Map((series || []).map((p) => [p.d, p.v]))
  map.set(q.d, q.v)
  // ひとつ前の日の値を、CNBC の「前日の終値」で上書きする（場中の値や日付の取り違えで入った値を自動で直す。
  // 2026-11-21: 11/20 の場中の値が 11/19 の欄に残っていた）。前の日が4日以上離れている（欠けた日がある）時は触らない
  if (q.pc != null) {
    const prevD = [...map.keys()].filter((d) => d < q.d).sort().at(-1)
    if (prevD && (Date.parse(q.d) - Date.parse(prevD)) / 86400e3 <= 4 && Math.abs(q.pc / map.get(prevD) - 1) < 0.05) {
      map.set(prevD, q.pc)
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-keep)
    .map(([d, v]) => ({ d, v }))
}

// 履歴ソース → 取れたら CNBC の最新値で当日分を上書き。全滅なら前回データに CNBC を継ぎ足す
async function historyPlusLatest(label, historySources, cnbcSym, prevSeries, keep = 130) {
  let out = null
  try {
    out = await firstOk(label, historySources)
  } catch (e) {
    console.warn(`${label}: 履歴ソース全滅 → CNBCで継ぎ足し`)
  }
  let q = null
  try {
    q = await cnbcQuote(cnbcSym)
  } catch (e) {
    console.warn(`${label}: ${e.message}`)
  }
  if (out) {
    if (q && q.d >= out.series.at(-1).d) {
      out.series = appendPoint(out.series, q, keep)
      out.updatedAt = q.t
      out.source += '+CNBC'
    }
    return out
  }
  if (q && prevSeries?.length) return { series: appendPoint(prevSeries, q, keep), updatedAt: q.t, source: 'CNBC' }
  throw new Error(`${label}: 全ソース失敗`)
}

const yahoo = (sym, range) => async () => ({ ...(await yahooSeries(sym, range)), source: 'Yahoo' })

async function fetchVix(prev) {
  return historyPlusLatest(
    'vix',
    [() => cboeSeries('VIX'), () => cboeCsv('VIX'), () => fredSeries('VIXCLS'), yahoo('^VIX')],
    '.VIX',
    prev?.series,
  )
}

async function fetchTnx(prev) {
  const out = await historyPlusLatest(
    'tnx',
    [() => cboeSeries('TNX'), () => stooqSeries('10usy.b'), () => fredSeries('DGS10'), yahoo('^TNX')],
    'US10Y',
    prev?.series,
  )
  // CBOE の TNX は利回り×10（例: 42.5）で配信されるので補正
  out.series = out.series.map((p) => ({ d: p.d, v: round(p.v > 20 ? p.v / 10 : p.v, 3) }))
  return out
}

// ---------- CNN Fear & Greed ----------
async function fetchFearGreed() {
  const json = await getJSON('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    Referer: 'https://edition.cnn.com/',
    Origin: 'https://edition.cnn.com',
  })
  const fg = json.fear_and_greed
  if (!fg || fg.score == null) throw new Error('CNN: fear_and_greed が空')
  const map = new Map()
  for (const p of json.fear_and_greed_historical?.data || []) {
    map.set(nyDate(new Date(p.x)), round(p.y, 1))
  }
  map.set(nyDate(new Date(fg.timestamp)), round(fg.score, 1))
  const series = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-130)
    .map(([d, v]) => ({ d, v }))
  return {
    series,
    rating: fg.rating,
    previousClose: fg.previous_close != null ? round(fg.previous_close, 1) : null,
    previousWeek: fg.previous_1_week != null ? round(fg.previous_1_week, 1) : null,
    previousMonth: fg.previous_1_month != null ? round(fg.previous_1_month, 1) : null,
    updatedAt: new Date(fg.timestamp).toISOString(),
  }
}

// ---------- CBOE Put/Call Ratio ----------
function pickRatio(ratios, name) {
  const r = ratios.find((x) => x.name?.toUpperCase() === name)
  const v = r ? parseFloat(r.value) : NaN
  return Number.isFinite(v) ? v : null
}

async function fetchPutCall(prev) {
  // 過去分は前回の data.json から引き継ぎ、足りない日だけ取りに行く
  const have = new Map((prev?.series || []).map((p) => [p.d, p]))
  const bootstrap = have.size < 40
  const lookback = bootstrap ? 130 : 10 // 暦日
  const today = new Date()
  const dates = []
  for (let i = 0; i <= lookback; i++) {
    const d = new Date(today.getTime() - i * 86400000)
    const dow = new Date(nyDate(d) + 'T12:00:00Z').getUTCDay()
    if (dow === 0 || dow === 6) continue
    dates.push(nyDate(d))
  }
  const recent = new Set(dates.slice(0, 2)) // 直近2営業日は場中更新があるので毎回取り直す
  let fetched = 0
  for (const d of [...new Set(dates)]) {
    if (have.has(d) && !recent.has(d)) continue
    try {
      const json = await getJSON(
        `https://cdn.cboe.com/data/us/options/market_statistics/daily/${d}_daily_options`,
      )
      const ratios = json.ratios || []
      const total = pickRatio(ratios, 'TOTAL PUT/CALL RATIO')
      if (total != null) {
        have.set(d, {
          d,
          v: total,
          equity: pickRatio(ratios, 'EQUITY PUT/CALL RATIO'),
          index: pickRatio(ratios, 'INDEX PUT/CALL RATIO'),
        })
        fetched++
      }
    } catch (e) {
      // 休場日や未公開日は 403/404 になるので無視
      if (![403, 404].includes(e.status)) console.warn(`CBOE ${d}: ${e.message}`)
    }
    await sleep(150)
  }
  if (have.size === 0) throw new Error('CBOE: 1日分も取得できず')
  const series = [...have.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-130)
  return { series, updatedAt: new Date().toISOString(), fetchedDays: fetched }
}

// ---------- S&P500 と移動平均線 ----------
async function fetchSpx(prev) {
  // 200日線の計算用に生の終値を330日分 raw として保存しておく
  const prevRaw = prev?.raw || prev?.series?.map((p) => ({ d: p.d, v: p.v }))
  const out = await historyPlusLatest(
    'spx',
    [() => cboeSeries('SPX', 330), () => stooqSeries('^spx', 330), () => fredSeries('SP500', 330), yahoo('^GSPC', '2y')],
    '.SPX',
    prevRaw,
    330,
  )
  const s = out.series
  const ma = (i, n) => {
    if (i + 1 < n) return null
    let sum = 0
    for (let j = i + 1 - n; j <= i; j++) sum += s[j].v
    return round(sum / n)
  }
  out.raw = s
  out.series = s.map((p, i) => ({ ...p, ma50: ma(i, 50), ma200: ma(i, 200) })).slice(-130)
  // 履歴が足りず200日線が計算できない日は、前回の値を引き継ぐ
  const prevMa = new Map((prev?.series || []).map((p) => [p.d, p]))
  // それも無い新しい日は直前の200日線で代用（1日の変化はごくわずか）
  let lastMa200 = null
  out.series = out.series.map((p) => {
    const o = prevMa.get(p.d)
    const ma200 = p.ma200 ?? o?.ma200 ?? lastMa200
    lastMa200 = ma200
    return { ...p, ma50: p.ma50 ?? o?.ma50 ?? null, ma200 }
  })
  return out
}

// ---------- SPY の日次 高値・安値・終値・出来高 ----------
// ディストリビューション・デー／フォロースルーデー（画面側で判定）用。S&P500 指数そのものの出来高は
// 無料で取れないので、SPY（S&P500 の ETF）の出来高で代用する。IBD の公式の数とはずれうる
const numStr = (s) => parseFloat(String(s ?? '').replace(/[$,]/g, ''))
const okBar = (p) => [p.v, p.h, p.l, p.vol].every(Number.isFinite) && p.vol > 0

async function nasdaqSpy() {
  const to = nyDate(new Date())
  const from = nyDate(new Date(Date.now() - 400 * 86400e3))
  const json = await getJSON(
    `https://api.nasdaq.com/api/quote/SPY/historical?assetclass=etf&fromdate=${from}&todate=${to}&limit=400`,
  )
  const rows = json?.data?.tradesTable?.rows
  if (!rows?.length) throw new Error('nasdaq SPY: 行なし')
  return rows
    .map((r) => {
      const [m, d, y] = String(r.date).split('/')
      return { d: `${y}-${m}-${d}`, v: numStr(r.close), h: numStr(r.high), l: numStr(r.low), vol: numStr(r.volume) }
    })
    .filter(okBar)
}

async function yahooSpy() {
  const json = await getJSON('https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1y&interval=1d')
  const r = json?.chart?.result?.[0]
  const q = r?.indicators?.quote?.[0]
  if (!r?.timestamp || !q) throw new Error('Yahoo SPY: 結果が空')
  return r.timestamp
    .map((t, i) => ({ d: nyDate(new Date(t * 1000)), v: round(q.close[i]), h: round(q.high[i]), l: round(q.low[i]), vol: q.volume[i] }))
    .filter(okBar)
}

async function fetchSpy() {
  const src = { nasdaq: nasdaqSpy, Yahoo: yahooSpy }
  const out = await firstOk('spy', Object.entries(src).map(([name, fn]) => async () => ({ rows: await fn(), name })))
  const map = new Map(out.rows.map((p) => [p.d, p]))
  let series = [...map.values()].sort((a, b) => a.d.localeCompare(b.d))
  // 場中の当日分は出来高が途中なので落とす（判定は引け値で行う）。NY 16:30 以降は残す
  const now = new Date()
  const nyMin = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now) * 60 +
    now.getUTCMinutes()
  if (series.at(-1)?.d === nyDate(now) && nyMin < 16 * 60 + 30) series = series.slice(0, -1)
  if (series.length < 60) throw new Error(`spy: 履歴が短い（${series.length}日）`)
  return { series: series.slice(-260), updatedAt: null, source: out.name }
}

// ---------- AAII センチメント調査（週次）----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
const pct = (t) => {
  const v = parseFloat(String(t).replace(/[^\d.\-]/g, ''))
  return Number.isFinite(v) ? v : null
}
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

function parseAaiiHtml(html) {
  const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => text(c[1])),
  )
  const now = new Date(nyDate(new Date()) + 'T12:00:00Z')
  let year = now.getUTCFullYear()
  let prevMonth = null
  const out = []
  for (const r of rows) {
    if (r.length < 4 || !r.slice(1, 4).every((c) => /%/.test(c))) continue
    const bull = pct(r[1]), neutral = pct(r[2]), bear = pct(r[3])
    if (bull == null || bear == null) continue
    let d = null
    let m = r[0].match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/) // 11/12/2026
    if (m) {
      const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]
      d = iso(y, +m[1] - 1, +m[2])
    } else if ((m = r[0].match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/))) {
      const mon = MONTHS[m[1].toLowerCase()]
      if (mon == null) continue
      if (m[3]) year = +m[3]
      else {
        // 年が書かれていない表は新しい順に並ぶ前提で年をさかのぼる
        if (prevMonth != null && mon > prevMonth) year--
        if (!out.length && new Date(Date.UTC(year, mon, +m[2])) > new Date(now.getTime() + 3 * 86400000)) year--
      }
      prevMonth = mon
      d = iso(year, mon, +m[2])
    }
    if (d) out.push({ d, v: round(bull - bear, 1), bull, neutral, bear })
  }
  return out
}

async function fetchAaii(prev) {
  const res = await fetch('https://www.aaii.com/sentimentsurvey/sent_results', {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!res.ok) throw new Error(`AAII HTTP ${res.status}`)
  const html = await res.text()
  const rows = parseAaiiHtml(html)
  if (!rows.length) {
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    const i = html.search(/bullish/i)
    throw new Error(
      `AAII: 表を読み取れず（${html.length}文字, title=${title}, 抜粋=${JSON.stringify(html.slice(Math.max(0, i - 200), i + 400))}）`,
    )
  }
  const have = new Map((prev?.series || []).map((p) => [p.d, p]))
  for (const r of rows) have.set(r.d, r)
  const series = [...have.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-104)
  return { series, updatedAt: new Date().toISOString(), source: 'AAII' }
}

// ---------- main ----------
// 画面の「最終更新」用: 最新の1点（日付・値・内訳）が前回と変わった時だけ今の時刻にする。
// updatedAt は取得元によって「気配の時刻」「日付だけ」「取りに行った時刻」と意味がばらばらなので使わない
// 比べるのは日付と値だけ（S&P500 の移動平均線は取得元が変わると小数点以下が揺れるため）
function changedAt(cur, prev, now, prevGeneratedAt) {
  const sig = (x) => { const p = x?.series?.at(-1); return p ? `${p.d}|${p.v}` : '' }
  if (!prev) return null // 初めて取る指標は、いつ値が変わったか分からない
  if (sig(cur) !== sig(prev)) return now
  if (prev.changedAt !== undefined) return prev.changedAt
  // 記録を始める前のデータ: 時刻つきの updatedAt を代用する。ただし前回の実行時刻と1時間以内のものは
  // 「取りに行った時刻」（プット・コール・レシオ、AAII）なので使わず、不明（null）にする
  const t = /T\d{2}:\d{2}/.test(prev.updatedAt ?? '') ? new Date(prev.updatedAt) : null
  if (!t || Number.isNaN(+t)) return null
  if (prevGeneratedAt && Math.abs(t - new Date(prevGeneratedAt)) < 3600e3) return null
  return t.toISOString()
}

async function main() {
  let prev = {}
  try {
    prev = JSON.parse(await readFile(OUT, 'utf8'))
  } catch {}

  const out = { generatedAt: new Date().toISOString(), errors: {} }
  const jobs = {
    vix: () => fetchVix(prev.vix),
    tnx: () => fetchTnx(prev.tnx),
    fearGreed: () => fetchFearGreed(),
    putCall: () => fetchPutCall(prev.putCall),
    aaii: () => fetchAaii(prev.aaii),
    spx: () => fetchSpx(prev.spx),
    spy: () => fetchSpy(),
  }
  let ok = 0
  // ONLY=putCall,vix のように指定すると一部だけ取得（テスト用）
  const only = process.env.ONLY?.split(',')
  for (const [key, fn] of Object.entries(jobs)) {
    if (only && !only.includes(key)) {
      if (prev[key]) out[key] = prev[key]
      continue
    }
    try {
      out[key] = await fn()
      out[key].changedAt = changedAt(out[key], prev[key], out.generatedAt, prev.generatedAt)
      ok++
      console.log(`✓ ${key}: ${out[key].series.length}件 最新=${JSON.stringify(out[key].series.at(-1))}`)
    } catch (e) {
      console.error(`✗ ${key}: ${e.message}`)
      out.errors[key] = e.message
      if (prev[key]) out[key] = { ...prev[key], stale: true }
    }
  }
  await writeFile(OUT, JSON.stringify(out, null, 1) + '\n')
  if (ok === 0) process.exit(1)
}

main()
