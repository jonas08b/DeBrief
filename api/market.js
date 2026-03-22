// api/market.js — DeBrief Markt proxy v2 (fixed)
//
// Quote bronnen (snel, geen key):
//   EUR/USD  → frankfurter.app
//   XAU/USD  → gold-api.com (realtime prijs, geen history)
//   WTI      → Alpha Vantage BRENT endpoint
//   US10Y    → FRED API
//   JPM      → Alpha Vantage GLOBAL_QUOTE
//   URTH     → Alpha Vantage GLOBAL_QUOTE
//
// Candle bronnen (historisch):
//   EUR/USD  → frankfurter.app tijdreeks
//   XAU/USD  → Alpha Vantage FX_DAILY (XAU→USD)
//   WTI      → Alpha Vantage BRENT commodity
//   US10Y    → FRED observations
//   JPM      → Alpha Vantage TIME_SERIES_DAILY
//   URTH     → Alpha Vantage TIME_SERIES_DAILY

const FRED_KEY = process.env.FRED_API_KEY;
const AV_KEY   = process.env.ALPHAVANTAGE_API_KEY;

// ── In-memory server-side cache (15 min) ──────────────────────────────────────
const CACHE     = {};
const CACHE_TTL = 15 * 60 * 1000;

function cacheGet(key) {
  const e = CACHE[key];
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { delete CACHE[key]; return null; }
  return e.data;
}
function cacheSet(key, data) {
  CACHE[key] = { data, ts: Date.now() };
  return data;
}
async function cached(key, fn) {
  const hit = cacheGet(key);
  if (hit) return hit;
  const data = await fn();
  return cacheSet(key, data);
}

// ── Fetch helper ──────────────────────────────────────────────────────────────
async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} voor ${url}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

async function quoteEURUSD() {
  return cached('q_eurusd', async () => {
    const cur = await fetchJSON('https://api.frankfurter.app/latest?from=EUR&to=USD');
    const price = cur.rates?.USD;
    if (!price) throw new Error('Geen EUR/USD data');
    const yDate = new Date();
    yDate.setDate(yDate.getDate() - 1);
    const yStr = yDate.toISOString().split('T')[0];
    let prevClose = price;
    try {
      const prev = await fetchJSON(`https://api.frankfurter.app/${yStr}?from=EUR&to=USD`);
      prevClose = prev.rates?.USD || price;
    } catch {}
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

async function quoteXAUUSD() {
  return cached('q_xauusd', async () => {
    const data = await fetchJSON('https://api.gold-api.com/price/XAU');
    const price = data.price;
    if (!price) throw new Error('Geen XAU data');
    const prev = data.prev_close_price || price;
    return { c: price, pc: prev, dp: ((price - prev) / prev) * 100 };
  });
}

async function quoteWTI() {
  return cached('q_wti', async () => {
    if (!AV_KEY) throw new Error('ALPHAVANTAGE_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=${AV_KEY}`
    );
    const series = data?.data;
    if (!series?.length) throw new Error('Geen BRENT data van Alpha Vantage');
    const price     = parseFloat(series[0].value);
    const prevClose = parseFloat(series[1]?.value || series[0].value);
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

async function quoteUS10Y() {
  return cached('q_us10y', async () => {
    if (!FRED_KEY) throw new Error('FRED_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`
    );
    const obs = data.observations?.filter(o => o.value !== '.');
    if (!obs?.length) throw new Error('Geen US10Y data van FRED');
    const price     = parseFloat(obs[0].value);
    const prevClose = parseFloat(obs[1]?.value || obs[0].value);
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

async function quoteAV(symbol) {
  return cached(`q_av_${symbol}`, async () => {
    if (!AV_KEY) throw new Error('ALPHAVANTAGE_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`
    );
    const q = data['Global Quote'];
    if (!q?.['05. price']) throw new Error(`Geen AV data voor ${symbol}`);
    const price     = parseFloat(q['05. price']);
    const prevClose = parseFloat(q['08. previous close']);
    const dp        = parseFloat(q['10. change percent']?.replace('%', '')) || 0;
    return { c: price, pc: prevClose, dp };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDLE ENDPOINTS  →  altijd { s, t:[], c:[] }
// ─────────────────────────────────────────────────────────────────────────────

function periodToStartDate(period) {
  const daysMap = { '1D': 3, '1M': 35, '6M': 185, '1J': 370 };
  const days    = daysMap[period] || 35;
  const d       = new Date();
  d.setDate(d.getDate() - days);
  return { startDate: d.toISOString().split('T')[0], days };
}

async function candleEURUSD(period) {
  return cached(`c_eurusd_${period}`, async () => {
    const { startDate } = periodToStartDate(period);
    const data = await fetchJSON(
      `https://api.frankfurter.app/${startDate}..?from=EUR&to=USD`
    );
    const entries = Object.entries(data.rates || {}).sort(([a],[b]) => a.localeCompare(b));
    if (!entries.length) return { s: 'no_data', t: [], c: [] };
    return {
      s: 'ok',
      t: entries.map(([d]) => Math.floor(new Date(d).getTime() / 1000)),
      c: entries.map(([, r]) => r.USD),
    };
  });
}

async function candleXAUUSD(period) {
  return cached(`c_xauusd_${period}`, async () => {
    if (!AV_KEY) return { s: 'no_data', t: [], c: [] };
    const { days } = periodToStartDate(period);
    const outputsize = days <= 100 ? 'compact' : 'full';
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=XAU&to_symbol=USD&outputsize=${outputsize}&apikey=${AV_KEY}`
    );
    return parseAVFXSeries(data['Time Series FX (Daily)'], days);
  });
}

async function candleWTI(period) {
  return cached(`c_wti_${period}`, async () => {
    if (!AV_KEY) return { s: 'no_data', t: [], c: [] };
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=${AV_KEY}`
    );
    const { days } = periodToStartDate(period);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const series = (data?.data || [])
      .filter(e => new Date(e.date) >= cutoff && e.value !== '.')
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!series.length) return { s: 'no_data', t: [], c: [] };
    return {
      s: 'ok',
      t: series.map(e => Math.floor(new Date(e.date).getTime() / 1000)),
      c: series.map(e => parseFloat(e.value)),
    };
  });
}

async function candleUS10Y(period) {
  return cached(`c_us10y_${period}`, async () => {
    if (!FRED_KEY) return { s: 'no_data', t: [], c: [] };
    const { startDate } = periodToStartDate(period);
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_KEY}&file_type=json&observation_start=${startDate}&sort_order=asc`
    );
    const obs = (data.observations || []).filter(o => o.value !== '.');
    if (!obs.length) return { s: 'no_data', t: [], c: [] };
    return {
      s: 'ok',
      t: obs.map(o => Math.floor(new Date(o.date).getTime() / 1000)),
      c: obs.map(o => parseFloat(o.value)),
    };
  });
}

async function candleAV(symbol, period) {
  return cached(`c_av_${symbol}_${period}`, async () => {
    if (!AV_KEY) return { s: 'no_data', t: [], c: [] };
    const { days } = periodToStartDate(period);
    const outputsize = days <= 100 ? 'compact' : 'full';
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=${outputsize}&apikey=${AV_KEY}`
    );
    return parseAVStockSeries(data['Time Series (Daily)'], days);
  });
}

// ── Alpha Vantage parse helpers ───────────────────────────────────────────────
function parseAVStockSeries(ts, days) {
  if (!ts) return { s: 'no_data', t: [], c: [] };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const entries = Object.entries(ts)
    .filter(([d]) => new Date(d) >= cutoff)
    .sort(([a],[b]) => a.localeCompare(b));
  if (!entries.length) return { s: 'no_data', t: [], c: [] };
  return {
    s: 'ok',
    t: entries.map(([d]) => Math.floor(new Date(d).getTime() / 1000)),
    c: entries.map(([, v]) => parseFloat(v['4. close'])),
  };
}

function parseAVFXSeries(ts, days) {
  if (!ts) return { s: 'no_data', t: [], c: [] };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const entries = Object.entries(ts)
    .filter(([d]) => new Date(d) >= cutoff)
    .sort(([a],[b]) => a.localeCompare(b));
  if (!entries.length) return { s: 'no_data', t: [], c: [] };
  return {
    s: 'ok',
    t: entries.map(([d]) => Math.floor(new Date(d).getTime() / 1000)),
    c: entries.map(([, v]) => parseFloat(v['4. close'])),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VERCEL HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { endpoint, symbol, period } = req.query;

  try {
    let data;

    if (endpoint === 'quote') {
      switch (symbol) {
        case 'EURUSD': data = await quoteEURUSD();   break;
        case 'XAUUSD': data = await quoteXAUUSD();   break;
        case 'WTI':    data = await quoteWTI();       break;
        case 'US10Y':  data = await quoteUS10Y();     break;
        case 'JPM':    data = await quoteAV('JPM');   break;
        case 'URTH':   data = await quoteAV('URTH');  break;
        default: throw new Error(`Onbekend symbool: ${symbol}`);
      }
    } else if (endpoint === 'candle') {
      const p = period || '1M';
      switch (symbol) {
        case 'EURUSD': data = await candleEURUSD(p);       break;
        case 'XAUUSD': data = await candleXAUUSD(p);       break;
        case 'WTI':    data = await candleWTI(p);           break;
        case 'US10Y':  data = await candleUS10Y(p);         break;
        case 'JPM':    data = await candleAV('JPM', p);     break;
        case 'URTH':   data = await candleAV('URTH', p);    break;
        default: throw new Error(`Onbekend symbool: ${symbol}`);
      }
    } else {
      throw new Error(`Onbekend endpoint: ${endpoint}`);
    }

    res.status(200).json(data);
  } catch (err) {
    console.error('[market proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
}
