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

// ---------- S&P500 と移動平均線 ----------
async function fetchSpx() {
  const out = await firstOk('spx', [
    () => cboeSeries('SPX', 330),
    async () => ({ ...(await yahooSeries('^GSPC', '2y')), source: 'Yahoo' }),
  ])
  const s = out.series
  if (s.length < 200) throw new Error(`S&P500: 200日分に足りない（${s.length}件）`)
  const ma = (i, n) => {
    if (i + 1 < n) return null
    let sum = 0
    for (let j = i + 1 - n; j <= i; j++) sum += s[j].v
    return round(sum / n)
  }
  out.series = s.map((p, i) => ({ ...p, ma50: ma(i, 50), ma200: ma(i, 200) })).slice(-130)
  return out
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
    aaii: () => fetchAaii(prev.aaii),
    spx: () => fetchSpx(),
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
