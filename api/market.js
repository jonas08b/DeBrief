// api/market.js — Yahoo Finance v8/finance/chart only
// Geen npm packages, geen cookie/crumb — chart endpoint werkt zonder auth

const YF = 'https://query2.finance.yahoo.com/v8/finance/chart';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function chartFetch(symbol, params) {
  const qs  = new URLSearchParams(params).toString();
  const url = `${YF}/${encodeURIComponent(symbol)}?${qs}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  const data = await res.json();
  const err  = data?.chart?.error;
  if (err) throw new Error(err.description || err.code || 'Yahoo error');
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint, ...params } = req.query;

  try {
    let data;

    if (endpoint === 'quote') {
      // Haal per symbool de huidige prijs op via chart met range=1d
      // meta.regularMarketPrice bevat de actuele prijs — geen crumb nodig
      const symbols = params.symbols.split(',').map(s => s.trim());

      const results = await Promise.all(symbols.map(async sym => {
        try {
          const raw    = await chartFetch(sym, { range: '1d', interval: '5m', includePrePost: false });
          const meta   = raw.chart.result[0].meta;
          return {
            symbol:                     sym,
            regularMarketPrice:         meta.regularMarketPrice,
            regularMarketChangePercent: meta.regularMarketChangePercent ?? percentChange(meta),
            previousClose:              meta.previousClose ?? meta.chartPreviousClose,
            currency:                   meta.currency,
            shortName:                  meta.longName || meta.shortName || sym,
          };
        } catch (e) {
          return { symbol: sym, error: true, message: e.message };
        }
      }));

      data = results;

    } else if (endpoint === 'chart') {
      const sym = params.symbol;
      let chartParams;

      if (params.range === 'custom') {
        chartParams = {
          period1:        params.period1,
          period2:        params.period2,
          interval:       params.interval || '1d',
          includePrePost: false,
        };
      } else {
        chartParams = {
          range:          params.range || '1mo',
          interval:       params.interval || '1d',
          includePrePost: false,
        };
      }

      data = await chartFetch(sym, chartParams);

    } else if (endpoint === 'search') {
      // Yahoo Finance search — geen crumb nodig
      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(params.q)}&quotesCount=6&newsCount=0&enableFuzzyQuery=false&lang=en-US`;
      const res2 = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res2.ok) throw new Error(`Search ${res2.status}`);
      data = await res2.json();

    } else {
      return res.status(400).json({ error: `Onbekend endpoint: ${endpoint}` });
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);

  } catch (err) {
    console.error('[market]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Bereken % change als Yahoo het niet meegeeft
function percentChange(meta) {
  const cur  = meta.regularMarketPrice;
  const prev = meta.previousClose ?? meta.chartPreviousClose;
  if (!cur || !prev) return null;
  return ((cur - prev) / prev) * 100;
}
