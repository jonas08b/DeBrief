// api/market.js — DeBrief Markt proxy v6
//
// EUR/USD  → frankfurter.app    (gratis, geen key)
// XAU/USD  → gold-api.com       (gratis, geen key)
// XAU pct  → gold-api.com       (gratis, geen key)  ← FIX #1 & #2: geen AV meer
// WTI      → Alpha Vantage BRENT (gratis, key vereist)
// US10Y    → FRED API            (gratis, key vereist)
// Aandelen → Alpha Vantage       (gratis, key vereist)
// Search   → Alpha Vantage SYMBOL_SEARCH (gratis, key vereist)
//
// Cache-strategie:
//   1. Vercel Edge Cache-Control headers → CDN cached per endpoint+symbol
//   2. In-memory stale-while-revalidate → bij AV rate-limit stale data teruggeven
//
// FIX #5: In-memory cache werkt per instantie. De Vercel Cache-Control header
//         is de primaire bescherming tegen cold-start cache-misses.

const FRED_KEY = process.env.FRED_API_KEY;
const AV_KEY   = process.env.ALPHAVANTAGE_API_KEY;

// ── Toegestane symbolen (FIX #7: voorkom willekeurige AV-calls) ──────────────
const ALLOWED_QUOTE_SYMBOLS = new Set(['EURUSD', 'XAUUSD', 'WTI', 'US10Y']);
const ALLOWED_PCT_SYMBOLS   = new Set(['EURUSD', 'XAUUSD', 'WTI', 'US10Y']);
// Aandelen/ETF-symbolen: alleen letters, cijfers, punt en koppelteken, max 12 tekens
function isValidEquitySymbol(s) {
  return typeof s === 'string' && /^[A-Z0-9.\-]{1,12}$/.test(s);
}
function sanitiseSymbol(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
}
function sanitiseSearchQuery(q) {
  return String(q || '').replace(/[^a-zA-Z0-9 .\/\-]/g, '').trim().slice(0, 50);
}

// ── In-memory cache (stale-while-revalidate) ──────────────────────────────────
// FIX #5: Cache werkt per serverless instantie. De Vercel CDN-cache (s-maxage)
//         is de echte bescherming; deze in-memory cache helpt binnen één instantie.
const CACHE     = {};
const FRESH_TTL = 5  * 60 * 1000;  //  5 min: fresh data
const STALE_TTL = 60 * 60 * 1000;  // 60 min: stale maar bruikbaar bij fout

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

function avCheckRateLimit(data) {
  if (data?.Note || data?.Information) {
    throw new Error('Alpha Vantage rate limit');
  }
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
    avCheckRateLimit(data);
    const series = data?.data;
    if (!series?.length) throw new Error('Geen BRENT data');
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
    if (!obs?.length) throw new Error('Geen US10Y data');
    const price     = parseFloat(obs[0].value);
    const prevClose = parseFloat(obs[1]?.value || obs[0].value);
    return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100 };
  });
}

async function quoteAV(symbol) {
  // FIX #7: validatie gebeurt vóór deze aanroep in de handler
  return cached(`q_av_${symbol}`, async () => {
    if (!AV_KEY) throw new Error('ALPHAVANTAGE_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`
    );
    avCheckRateLimit(data);
    const q = data['Global Quote'];
    if (!q?.['05. price']) throw new Error(`Geen data voor ${symbol}`);
    return {
      c:  parseFloat(q['05. price']),
      pc: parseFloat(q['08. previous close']),
      dp: parseFloat(q['10. change percent']?.replace('%', '')) || 0,
    };
  });
}

// ── PCT ───────────────────────────────────────────────────────────────────────

// FIX #6: ruimere buffer zodat `outputsize=compact` (100 datapunten) altijd volstaat
// voor periodes t.e.m. 6 maanden. Voor 1 jaar: full outputsize verplicht.
function periodToStartDate(period) {
  const daysMap = { '1month': 40, '6month': 195, '1year': 375 };
  const days    = daysMap[period] || 40;
  const d       = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

// FIX #6: gebruik outputsize=full alleen wanneer nodig
function avOutputSize(period) {
  return period === '1year' ? 'full' : 'compact';
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

// FIX #1 & #2: XAU pct via gold-api.com history, geen AV-call meer
async function pctXAUUSD(period) {
  return cached(`pct_xauusd_${period}`, async () => {
    const startDate = periodToStartDate(period);
    try {
      // gold-api.com biedt historische data via /price/XAU/history (gratis)
      const data = await fetchJSON(
        `https://api.gold-api.com/price/XAU/history?startDate=${startDate}`
      );
      const entries = (data?.history || data?.data || [])
        .filter(e => e.date && e.price)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (entries.length < 2) return { dp: null };
      const first = parseFloat(entries[0].price);
      const last  = parseFloat(entries[entries.length - 1].price);
      if (!first || !last) return { dp: null };
      return { dp: ((last - first) / first) * 100 };
    } catch {
      // Fallback: geen pct beschikbaar zonder AV-call
      return { dp: null };
    }
  });
}

async function pctWTI(period) {
  return cached(`pct_wti_${period}`, async () => {
    if (!AV_KEY) return { dp: null };
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=${AV_KEY}`
    );
    avCheckRateLimit(data);
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
  // FIX #7: validatie gebeurt vóór deze aanroep in de handler
  return cached(`pct_av_${symbol}_${period}`, async () => {
    if (!AV_KEY) return { dp: null };
    const outputsize = avOutputSize(period); // FIX #6
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=${outputsize}&apikey=${AV_KEY}`
    );
    avCheckRateLimit(data);
    return pctFromAVSeries(data['Time Series (Daily)'], periodToStartDate(period), '4. close');
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

// ── Symbol search ─────────────────────────────────────────────────────────────
// FIX #3: geef full_name correct door zodat frontend een geldig TV-symbool bouwt
async function searchSymbols(q) {
  return cached(`search_${q.toLowerCase()}`, async () => {
    if (!AV_KEY) throw new Error('ALPHAVANTAGE_API_KEY niet ingesteld');
    const data = await fetchJSON(
      `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(q)}&apikey=${AV_KEY}`
    );
    avCheckRateLimit(data);
    const hits = (data?.bestMatches || []).slice(0, 8).map(m => {
      const symbol   = m['1. symbol'];
      const region   = m['4. region'] || '';
      const exchange = m['8. currency'] ? (m['9. matchScore'] ? m['4. region'] : '') : region;

      // FIX #3: bouw een bruikbaar TradingView-symbool (exchange:symbol)
      // AV geeft geen exchange prefix; we leiden die af uit de regio
      const tvExchange = avRegionToTVExchange(region);
      const full_name  = tvExchange ? `${tvExchange}:${symbol}` : symbol;

      return {
        symbol,
        full_name,               // bruikbaar als TradingView-symbool
        description: m['2. name'],
        exchange:    region,
        type:        (m['3. type'] || 'Equity').toLowerCase(),
      };
    });
    return { hits };
  });
}

// Hulpfunctie: AV regio → TradingView exchange prefix
function avRegionToTVExchange(region) {
  const map = {
    'United States':  'NASDAQ',   // beste gok; TV zoekt zelf de juiste beurs
    'United Kingdom': 'LSE',
    'Canada':         'TSX',
    'Germany':        'XETR',
    'France':         'EURONEXT',
    'Japan':          'TSE',
    'China':          'SSE',
    'Hong Kong':      'HKEX',
    'India':          'BSE',
    'Australia':      'ASX',
    'Belgium':        'EURONEXT',
    'Netherlands':    'EURONEXT',
  };
  return map[region] || null; // null → geen prefix, TV zoekt automatisch
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Vercel Edge Cache: 5 min fresh, 10 min stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { endpoint } = req.query;

  // FIX #7: sanitiseer alle inputs vóór verwerking
  const rawSymbol = req.query.symbol || '';
  const rawPeriod = req.query.period || '1month';
  const rawQuery  = req.query.q      || '';

  const symbol = sanitiseSymbol(rawSymbol);
  const period = ['1month', '6month', '1year'].includes(rawPeriod) ? rawPeriod : '1month';
  const q      = sanitiseSearchQuery(rawQuery);

  try {
    let data;

    if (endpoint === 'quote') {
      if (ALLOWED_QUOTE_SYMBOLS.has(symbol)) {
        // Bekende preset-symbolen
        switch (symbol) {
          case 'EURUSD': data = await quoteEURUSD();   break;
          case 'XAUUSD': data = await quoteXAUUSD();   break;
          case 'WTI':    data = await quoteWTI();       break;
          case 'US10Y':  data = await quoteUS10Y();     break;
        }
      } else if (isValidEquitySymbol(symbol)) {
        // Custom aandeel/ETF via Alpha Vantage
        data = await quoteAV(symbol);
      } else {
        throw new Error(`Ongeldig symbool: ${rawSymbol}`);
      }

    } else if (endpoint === 'pct') {
      if (ALLOWED_PCT_SYMBOLS.has(symbol)) {
        switch (symbol) {
          case 'EURUSD': data = await pctEURUSD(period);   break;
          case 'XAUUSD': data = await pctXAUUSD(period);   break;
          case 'WTI':    data = await pctWTI(period);       break;
          case 'US10Y':  data = await pctUS10Y(period);     break;
        }
      } else if (isValidEquitySymbol(symbol)) {
        data = await pctAV(symbol, period);
      } else {
        throw new Error(`Ongeldig symbool: ${rawSymbol}`);
      }

    } else if (endpoint === 'search') {
      if (!q) throw new Error('Zoekterm ontbreekt');
      data = await searchSymbols(q);

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
