// 買い場ゲージ: データ取得スクリプト
// GitHub Actions から定期実行され、data.json を更新する。
// 依存パッケージなし（Node 20+ の fetch を使用）。
//
// 取得元:
//   VIX / 米10年債利回り … Yahoo Finance (^VIX / ^TNX)
//   Fear & Greed Index   … CNN
//   プット・コール・レシオ … CBOE 日次マーケット統計
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
async function cboeSeries(sym) {
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
    .slice(-130)
    .map(([d, v]) => ({ d, v: round(v) }))
  return { series, updatedAt, source: 'CBOE' }
}

// ---------- FRED（米10年債の公式日次データ、1営業日遅れ）----------
async function fredSeries(id) {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`FRED HTTP ${res.status}`)
  const lines = (await res.text()).trim().split('\n').slice(1)
  const series = lines
    .map((l) => l.split(','))
    .filter(([, v]) => v && v !== '.' && Number.isFinite(parseFloat(v)))
    .map(([d, v]) => ({ d, v: parseFloat(v) }))
    .slice(-130)
  if (!series.length) throw new Error('FRED: データ空')
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

async function fetchVix() {
  return firstOk('vix', [
    () => cboeSeries('VIX'),
    async () => ({ ...(await yahooSeries('^VIX')), source: 'Yahoo' }),
  ])
}

async function fetchTnx() {
  const out = await firstOk('tnx', [
    () => cboeSeries('TNX'),
    () => fredSeries('DGS10'),
    async () => ({ ...(await yahooSeries('^TNX')), source: 'Yahoo' }),
  ])
  // 昔の ^TNX は利回り×10（例: 42.5）で配信されていたので念のため補正
  const vals = out.series.map((p) => p.v).sort((a, b) => a - b)
  const median = vals[Math.floor(vals.length / 2)] ?? 0
  if (median > 20) out.series = out.series.map((p) => ({ d: p.d, v: round(p.v / 10, 3) }))
  out.series = out.series.map((p) => ({ d: p.d, v: round(p.v, 3) }))
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

// ---------- main ----------
async function main() {
  let prev = {}
  try {
    prev = JSON.parse(await readFile(OUT, 'utf8'))
  } catch {}

  const out = { generatedAt: new Date().toISOString(), errors: {} }
  const jobs = {
    vix: () => fetchVix(),
    tnx: () => fetchTnx(),
    fearGreed: () => fetchFearGreed(),
    putCall: () => fetchPutCall(prev.putCall),
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
