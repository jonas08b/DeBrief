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

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { endpoint, symbol } = req.query;

  if (endpoint !== 'quote') {
    return res.status(400).json({ error: 'Enkel quote endpoint beschikbaar' });
  }

  try {
    let data;
    switch (symbol) {
      case 'EURUSD': data = await quoteEURUSD();   break;
      case 'XAUUSD': data = await quoteXAUUSD();   break;
      case 'WTI':    data = await quoteWTI();       break;
      case 'US10Y':  data = await quoteUS10Y();     break;
      case 'JPM':    data = await quoteAV('JPM');   break;
      case 'URTH':   data = await quoteAV('URTH');  break;
      default: throw new Error(`Onbekend symbool: ${symbol}`);
    }
    res.status(200).json(data);
  } catch (err) {
    console.error('[market proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
}
