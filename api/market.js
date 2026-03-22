// api/market.js — DeBrief Markt proxy
// Bronnen:
//   EUR/USD       → frankfurter.app        (gratis, geen key)
//   XAU/USD       → gold-api.com           (gratis, geen key)
//   WTI (Brent)   → oilpriceapi.com        (gratis, 1000/maand)
//   US10Y         → FRED API               (gratis, key vereist)
//   JPM           → Alpha Vantage          (gratis, key vereist, 25/dag)
//   URTH          → Alpha Vantage          (gratis, key vereist, 25/dag)
//
// Server-side in-memory cache (15 min) → Alpha Vantage calls worden gedeeld
// over alle bezoekers, max ~96 calls/dag ongeacht bezoekersaantal.

const FRED_KEY   = process.env.FRED_API_KEY;        // https://fred.stlouisfed.org/docs/api/api_key.html
const AV_KEY     = process.env.ALPHAVANTAGE_API_KEY; // https://www.alphavantage.co/support/#api-key
const OIL_KEY    = process.env.OILPRICE_API_KEY;     // https://www.oilpriceapi.com

// ── In-memory server-side cache ───────────────────────────────────────────────
const CACHE     = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 minuten

function cacheGet(key) {
  const e = CACHE[key];
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { delete CACHE[key]; return null; }
  return e.data;
}
function cacheSet(key, data) {
  CACHE[key] = { data, ts: Date.now() };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} voor ${url}`);
  return res.json();
}

// ── EUR/USD — Frankfurter.app ─────────────────────────────────────────────────
async function getEURUSD() {
  const key = 'eurusd';
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await fetchJSON('https://api.frankfurter.app/latest?from=EUR&to=USD');
  const price = data.rates?.USD;
  if (!price) throw new Error('Geen EUR/USD data van Frankfurter');

  // Haal ook vorige dag op voor % change
  const yesterday = await fetchJSON('https://api.frankfurter.app/latest?from=EUR&to=USD&amount=1');
  // Frankfurter geeft geen prev close rechtstreeks — gebruik /YYYY-MM-DD voor gisteren
  const yDate = new Date();
  yDate.setDate(yDate.getDate() - 1);
  const yStr = yDate.toISOString().split('T')[0];
  let prevClose = price;
  try {
    const prev = await fetchJSON(`https://api.frankfurter.app/${yStr}?from=EUR&to=USD`);
    prevClose = prev.rates?.USD || price;
  } catch {}

  const dp = ((price - prevClose) / prevClose) * 100;
  const result = { c: price, pc: prevClose, dp };
  cacheSet(key, result);
  return result;
}

// ── XAU/USD — gold-api.com ────────────────────────────────────────────────────
async function getXAUUSD() {
  const key = 'xauusd';
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await fetchJSON('https://api.gold-api.com/price/XAU');
  const price = data.price;
  if (!price) throw new Error('Geen XAU/USD data van gold-api');

  const prevClose = data.prev_close_price || price;
  const dp = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  const result = { c: price, pc: prevClose, dp };
  cacheSet(key, result);
  return result;
}

// ── WTI/Brent — OilPriceAPI ───────────────────────────────────────────────────
async function getWTI() {
  const key = 'wti';
  const cached = cacheGet(key);
  if (cached) return cached;

  if (!OIL_KEY) throw new Error('OILPRICE_API_KEY niet ingesteld');
  const data = await fetchJSON(
    `https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD`,
    { Authorization: `Token ${OIL_KEY}` }
  );
  const price = parseFloat(data.data?.price);
  if (!price) throw new Error('Geen WTI data van OilPriceAPI');

  // OilPriceAPI geeft geen prev close — haal gisteren op
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().split('T')[0];
  let prevClose = price;
  try {
    const prev = await fetchJSON(
      `https://api.oilpriceapi.com/v1/prices?by_code=BRENT_CRUDE_USD&start_at=${yStr}&end_at=${yStr}`,
      { Authorization: `Token ${OIL_KEY}` }
    );
    prevClose = parseFloat(prev.data?.[0]?.price) || price;
  } catch {}

  const dp = ((price - prevClose) / prevClose) * 100;
  const result = { c: price, pc: prevClose, dp };
  cacheSet(key, result);
  return result;
}

// ── US10Y — FRED API ──────────────────────────────────────────────────────────
async function getUS10Y() {
  const key = 'us10y';
  const cached = cacheGet(key);
  if (cached) return cached;

  if (!FRED_KEY) throw new Error('FRED_API_KEY niet ingesteld');
  // DGS10 = 10-Year Treasury Constant Maturity Rate, dagelijks
  const data = await fetchJSON(
    `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`
  );
  const obs = data.observations?.filter(o => o.value !== '.');
  if (!obs?.length) throw new Error('Geen US10Y data van FRED');

  const price    = parseFloat(obs[0].value);
  const prevClose = parseFloat(obs[1]?.value || obs[0].value);
  const dp = ((price - prevClose) / prevClose) * 100;
  const result = { c: price, pc: prevClose, dp };
  cacheSet(key, result);
  return result;
}

// ── Alpha Vantage (JPM + URTH) ────────────────────────────────────────────────
async function getAlphaVantage(symbol) {
  const key = `av_${symbol}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  if (!AV_KEY) throw new Error('ALPHAVANTAGE_API_KEY niet ingesteld');
  const data = await fetchJSON(
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`
  );
  const q = data['Global Quote'];
  if (!q || !q['05. price']) throw new Error(`Geen Alpha Vantage data voor ${symbol}`);

  const price    = parseFloat(q['05. price']);
  const prevClose = parseFloat(q['08. previous close']);
  const dp = parseFloat(q['10. change percent']?.replace('%', '')) || 0;
  const result = { c: price, pc: prevClose, dp };
  cacheSet(key, result);
  return result;
}

// ── Historische candles ───────────────────────────────────────────────────────
// Geeft altijd { s, t, c } terug — zelfde formaat als Finnhub
async function getCandles(symbol, period) {
  const key = `candle_${symbol}_${period}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let result;

  if (symbol === 'EURUSD') {
    result = await getCandlesFrankfurter('EUR', 'USD', period);
  } else if (symbol === 'XAUUSD') {
    result = await getCandlesGoldAPI(period);
  } else if (symbol === 'WTI') {
    result = await getCandlesOil(period);
  } else if (symbol === 'US10Y') {
    result = await getCandlesFRED(period);
  } else {
    // JPM, URTH → Alpha Vantage
    result = await getCandlesAV(symbol, period);
  }

  cacheSet(key, result);
  return result;
}

// Frankfurter historisch (EUR/USD)
async function getCandlesFrankfurter(from, to, period) {
  const { startDate } = periodToDates(period);
  const data = await fetchJSON(
    `https://api.frankfurter.app/${startDate}..?from=${from}&to=${to}`
  );
  const entries = Object.entries(data.rates || {}).sort(([a],[b]) => a.localeCompare(b));
  if (!entries.length) return { s: 'no_data', t: [], c: [] };
  return {
    s: 'ok',
    t: entries.map(([d]) => Math.floor(new Date(d).getTime() / 1000)),
    c: entries.map(([, r]) => r[to]),
  };
}

// Gold-API historisch
async function getCandlesGoldAPI(period) {
  const { days } = periodToDates(period);
  // gold-api.com geeft OHLC per dag terug
  const data = await fetchJSON(`https://api.gold-api.com/price/XAU/history?days=${days}`);
  if (!data?.history?.length) return { s: 'no_data', t: [], c: [] };
  const sorted = [...data.history].sort((a, b) => new Date(a.date) - new Date(b.date));
  return {
    s: 'ok',
    t: sorted.map(e => Math.floor(new Date(e.date).getTime() / 1000)),
    c: sorted.map(e => e.price),
  };
}

// OilPriceAPI historisch
async function getCandlesOil(period) {
  if (!OIL_KEY) return { s: 'no_data', t: [], c: [] };
  const { startDate } = periodToDates(period);
  const today = new Date().toISOString().split('T')[0];
  const data = await fetchJSON(
    `https://api.oilpriceapi.com/v1/prices?by_code=BRENT_CRUDE_USD&start_at=${startDate}&end_at=${today}`,
    { Authorization: `Token ${OIL_KEY}` }
  );
  if (!data?.data?.length) return { s: 'no_data', t: [], c: [] };
  const sorted = [...data.data].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return {
    s: 'ok',
    t: sorted.map(e => Math.floor(new Date(e.created_at).getTime() / 1000)),
    c: sorted.map(e => parseFloat(e.price)),
  };
}

// FRED historisch (US10Y)
async function getCandlesFRED(period) {
  if (!FRED_KEY) return { s: 'no_data', t: [], c: [] };
  const { startDate } = periodToDates(period);
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
}

// Alpha Vantage historisch (JPM, URTH)
async function getCandlesAV(symbol, period) {
  if (!AV_KEY) return { s: 'no_data', t: [], c: [] };
  const { days } = periodToDates(period);
  const outputsize = days <= 100 ? 'compact' : 'full';
  const data = await fetchJSON(
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=${outputsize}&apikey=${AV_KEY}`
  );
  const ts = data['Time Series (Daily)'];
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

// ── Hulpfunctie: period → startdatum + dagen ──────────────────────────────────
function periodToDates(period) {
  const now = new Date();
  const daysMap = { '1D': 2, '1M': 31, '6M': 183, '1J': 366 };
  const days = daysMap[period] || 31;
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return {
    days,
    startDate: start.toISOString().split('T')[0],
  };
}

// ── Vercel handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { endpoint, symbol, period } = req.query;

  try {
    let data;

    if (endpoint === 'quote') {
      switch (symbol) {
        case 'EURUSD':  data = await getEURUSD();               break;
        case 'XAUUSD':  data = await getXAUUSD();               break;
        case 'WTI':     data = await getWTI();                  break;
        case 'US10Y':   data = await getUS10Y();                break;
        case 'JPM':     data = await getAlphaVantage('JPM');    break;
        case 'URTH':    data = await getAlphaVantage('URTH');   break;
        default: throw new Error(`Onbekend symbool: ${symbol}`);
      }
    } else if (endpoint === 'candle') {
      data = await getCandles(symbol, period || '1M');
    } else {
      throw new Error(`Onbekend endpoint: ${endpoint}`);
    }

    res.status(200).json(data);
  } catch (err) {
    console.error('[market proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
}
