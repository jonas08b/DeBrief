// api/market.js — DeBrief Markt proxy v6
//
// EUR/USD  → frankfurter.app  (gratis, geen key)
// XAU/USD  → gold-api.com     (gratis, geen key)
// US10Y    → FRED API          (gratis, key vereist)
// WTI      → Finnhub           (gratis, key vereist, 60/min)
// Aandelen → Finnhub           (gratis, key vereist, 60/min)
// Search   → Finnhub           (gratis, key vereist, 60/min)
//
// Cache-strategie:
//   Vercel Edge Cache-Control → CDN cached per endpoint+symbol (5 min)
//   In-memory stale-while-revalidate → bij fout stale data teruggeven (60 min)

const FRED_KEY    = process.env.FRED_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

// ── In-memory cache (stale-while-revalidate) ──────────────────────────────────
const CACHE     = {};
const FRESH_TTL = 5  * 60 * 1000;
const STALE_TTL = 60 * 60 * 1000;

function cacheGet(key) {
  const e = CACHE[key];
  if (!e) return { fresh: null, stale: null };
  const age = Date.now() - e.ts;
  if (age > STALE_TTL) { delete CACHE[key]; return { fresh: null, stale: null }; }
  if (age > FRESH_TTL) return { fresh: null, stale: e.data };
  return { fresh: e.data, stale: e.data };
}
function cacheSet(key, data) {
  CACHE[key] = { data, ts: Date.now() };
  return data;
}
async function cached(key, fn) {
  const { fresh, stale } = cacheGet(key);
  if (fresh) return fresh;
  try {
    const data = await fn();
    return cacheSet(key, data);
  } catch (err) {
    if (stale) {
      console.warn(`[market] Stale data voor ${key}: ${err.message}`);
      return { ...stale, stale: true };
    }
    throw err;
  }
}

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} voor ${url}`);
  return res.json();
}

// ── Quotes ────────────────────────────────────────────────────────────────────

async function quoteEURUSD() {
  return cached('q_eurusd', async () => {
    const cur = await fetchJSON('https://api.frankfurter.app/latest?from=EUR&to=USD');
    const price = cur.rates?.USD;
    if (!price) throw new Error('Geen EUR/USD data');
    const yDate = new Date();
    yDate.setDate(yDate.getDate() - 1);
    let prevClose = price;
    try {
      const prev = await fetchJSON(`https://api.frankfurter.app/${yDate.toISOString().split('T')[0]}?from=EUR&to=USD`);
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

async function quoteUS10Y() {
  return cached('q_us10y', async () => {
    if (!FRED_KEY) throw new Error('FRED_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5`
    );
    const obs = data.observations?.filter(o => o.value !== '.');
    if (!obs?.length) throw new Error('Geen US10Y data');
    const price     = parseFloat(obs[0].value);
    const prevClose = parseFloat(obs[1]?.value || obs[0].value);
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

// Finnhub quote: werkt voor aandelen, ETFs én commodities (WTI = "NYMEX:CL1!")
async function quoteFinnhub(symbol) {
  return cached(`q_fh_${symbol}`, async () => {
    if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
    );
    // Finnhub geeft { c: current, pc: prev close, d: change, dp: change% }
    if (!data?.c) throw new Error(`Geen Finnhub data voor ${symbol}`);
    return {
      c:  data.c,
      pc: data.pc,
      dp: data.dp,
    };
  });
}

// ── PCT ───────────────────────────────────────────────────────────────────────

function periodToStartDate(period) {
  const daysMap = { '1month': 35, '6month': 185, '1year': 370 };
  const days    = daysMap[period] || 35;
  const d       = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function periodToUnix(period) {
  const daysMap = { '1month': 35, '6month': 185, '1year': 370 };
  const days    = daysMap[period] || 35;
  const from    = Math.floor((Date.now() - days * 86400000) / 1000);
  const to      = Math.floor(Date.now() / 1000);
  return { from, to };
}

async function pctEURUSD(period) {
  return cached(`pct_eurusd_${period}`, async () => {
    const startDate = periodToStartDate(period);
    const data = await fetchJSON(`https://api.frankfurter.app/${startDate}..?from=EUR&to=USD`);
    const entries = Object.entries(data.rates || {}).sort(([a],[b]) => a.localeCompare(b));
    if (entries.length < 2) return { dp: null };
    const first = entries[0][1].USD;
    const last  = entries[entries.length - 1][1].USD;
    return { dp: ((last - first) / first) * 100 };
  });
}

async function pctXAUUSD(period) {
  return cached(`pct_xauusd_${period}`, async () => {
    // Goud via Finnhub candles (OANDA:XAU_USD)
    if (!FINNHUB_KEY) return { dp: null };
    const { from, to } = periodToUnix(period);
    const res = await fetchJSON(
      `https://finnhub.io/api/v1/forex/candle?symbol=OANDA:XAU_USD&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`
    );
    return pctFromCandles(res);
  });
}

async function pctUS10Y(period) {
  return cached(`pct_us10y_${period}`, async () => {
    if (!FRED_KEY) return { dp: null };
    const startDate = periodToStartDate(period);
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_KEY}&file_type=json&observation_start=${startDate}&sort_order=asc`
    );
    const obs = (data.observations || []).filter(o => o.value !== '.');
    if (obs.length < 2) return { dp: null };
    const first = parseFloat(obs[0].value);
    const last  = parseFloat(obs[obs.length - 1].value);
    return { dp: ((last - first) / first) * 100 };
  });
}

// Universele pct via Finnhub stock candles
async function pctFinnhub(symbol, period) {
  return cached(`pct_fh_${symbol}_${period}`, async () => {
    if (!FINNHUB_KEY) return { dp: null };
    const { from, to } = periodToUnix(period);
    const res = await fetchJSON(
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`
    );
    return pctFromCandles(res);
  });
}

function pctFromCandles(res) {
  // Finnhub candle response: { s: 'ok', c: [...closes], t: [...timestamps] }
  if (res?.s !== 'ok' || !res.c?.length || res.c.length < 2) return { dp: null };
  const first = res.c[0];
  const last  = res.c[res.c.length - 1];
  return { dp: ((last - first) / first) * 100 };
}

// ── Symbol search via Finnhub ─────────────────────────────────────────────────
async function searchSymbols(q) {
  return cached(`search_${q.toLowerCase()}`, async () => {
    if (!FINNHUB_KEY) throw new Error('FINNHUB_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY}`
    );
    // Finnhub geeft { count, result: [{ description, displaySymbol, symbol, type }] }
    const hits = (data?.result || []).slice(0, 8).map(m => ({
      symbol:    m.displaySymbol || m.symbol,
      full_name: m.symbol,
      name:      m.description,
      exchange:  m.type,
      type:      m.type?.toLowerCase(),
    }));
    return { hits };
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { endpoint, symbol, period } = req.query;

  // Interne symboolmapping: preset src-waarden → Finnhub symbolen
  const FINNHUB_MAP = {
    WTI:  'NYMEX:CL1!',  // WTI ruwe olie front-month future
    JPM:  'JPM',
    URTH: 'URTH',
  };

  try {
    let data;

    if (endpoint === 'quote') {
      switch (symbol) {
        case 'EURUSD': data = await quoteEURUSD();  break;
        case 'XAUUSD': data = await quoteXAUUSD();  break;
        case 'US10Y':  data = await quoteUS10Y();   break;
        default: {
          const fhSym = FINNHUB_MAP[symbol] || symbol;
          data = await quoteFinnhub(fhSym);
          break;
        }
      }
    } else if (endpoint === 'pct') {
      const p = period || '1month';
      switch (symbol) {
        case 'EURUSD': data = await pctEURUSD(p);   break;
        case 'XAUUSD': data = await pctXAUUSD(p);   break;
        case 'US10Y':  data = await pctUS10Y(p);    break;
        default: {
          const fhSym = FINNHUB_MAP[symbol] || symbol;
          data = await pctFinnhub(fhSym, p);
          break;
        }
      }
    } else if (endpoint === 'search') {
      const q = req.query.q || '';
      if (!q.trim()) throw new Error('Zoekterm ontbreekt');
      data = await searchSymbols(q.trim());
    } else {
      throw new Error(`Onbekend endpoint: ${endpoint}`);
    }

    res.status(200).json(data);
  } catch (err) {
    console.error('[market proxy]', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: err.message });
  }
}
