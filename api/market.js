// api/market.js — DeBrief Markt proxy v3
// Grafieken → TradingView widget (geen candle endpoints meer nodig)
// Enkel quotes voor de tickerlijst prijzen + % change
//
// EUR/USD  → frankfurter.app    (gratis, geen key)
// XAU/USD  → gold-api.com       (gratis, geen key)
// WTI      → Alpha Vantage BRENT (gratis, key vereist)
// US10Y    → FRED API            (gratis, key vereist)
// JPM      → Alpha Vantage       (gratis, key vereist)
// URTH     → Alpha Vantage       (gratis, key vereist)

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
    return {
      c:  parseFloat(q['05. price']),
      pc: parseFloat(q['08. previous close']),
      dp: parseFloat(q['10. change percent']?.replace('%', '')) || 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PCT ENDPOINT — geeft alleen { dp } terug (% verandering over periode)
// Gebruikt minimale data: enkel startdatum + meest recente waarde
// ─────────────────────────────────────────────────────────────────────────────

function periodToStartDate(period) {
  const daysMap = { '1month': 35, '6month': 185, '1year': 370 };
  const days    = daysMap[period] || 35;
  const d       = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
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
    if (!AV_KEY) return { dp: null };
    const startDate = periodToStartDate(period);
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=XAU&to_symbol=USD&outputsize=full&apikey=${AV_KEY}`
    );
    return pctFromAVSeries(data['Time Series FX (Daily)'], startDate, '4. close');
  });
}

async function pctWTI(period) {
  return cached(`pct_wti_${period}`, async () => {
    if (!AV_KEY) return { dp: null };
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=${AV_KEY}`
    );
    const startDate = periodToStartDate(period);
    const series = (data?.data || [])
      .filter(e => e.date >= startDate && e.value !== '.')
      .sort((a, b) => a.date.localeCompare(b.date));
    if (series.length < 2) return { dp: null };
    const first = parseFloat(series[0].value);
    const last  = parseFloat(series[series.length - 1].value);
    return { dp: ((last - first) / first) * 100 };
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

async function pctAV(symbol, period) {
  return cached(`pct_av_${symbol}_${period}`, async () => {
    if (!AV_KEY) return { dp: null };
    const startDate = periodToStartDate(period);
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=full&apikey=${AV_KEY}`
    );
    return pctFromAVSeries(data['Time Series (Daily)'], startDate, '4. close');
  });
}

function pctFromAVSeries(ts, startDate, closeKey) {
  if (!ts) return { dp: null };
  const entries = Object.entries(ts)
    .filter(([d]) => d >= startDate)
    .sort(([a],[b]) => a.localeCompare(b));
  if (entries.length < 2) return { dp: null };
  const first = parseFloat(entries[0][1][closeKey]);
  const last  = parseFloat(entries[entries.length - 1][1][closeKey]);
  return { dp: ((last - first) / first) * 100 };
}

// ── Handler ───────────────────────────────────────────────────────────────────
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
        default:       data = await quoteAV(symbol);  break; // AAPL, MSFT, etc.
      }
    } else if (endpoint === 'pct') {
      const p = period || '1month';
      switch (symbol) {
        case 'EURUSD': data = await pctEURUSD(p);       break;
        case 'XAUUSD': data = await pctXAUUSD(p);       break;
        case 'WTI':    data = await pctWTI(p);           break;
        case 'US10Y':  data = await pctUS10Y(p);         break;
        default:       data = await pctAV(symbol, p);   break; // elk aandeel
      }
    } else if (endpoint === 'search') {
      const q      = req.query.q || '';
      const result = await fetchJSON(
        `https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(q)}&type=&exchange=&lang=nl_BE`
      );
      const hits = (result.symbols || []).slice(0, 8).map(s => ({
        symbol:    s.symbol,
        full_name: s.full_name,
        name:      s.description || s.symbol,
        exchange:  s.exchange,
        type:      s.type,
      }));
      data = { hits };
    } else {
      throw new Error(`Onbekend endpoint: ${endpoint}`);
    }

    res.status(200).json(data);
  } catch (err) {
    console.error('[market proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
}
