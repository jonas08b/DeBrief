// api/market.js — Vercel proxy via yahoo-finance2 npm package
// Installeer: npm install yahoo-finance2
// Geen API key nodig

import yahooFinance from 'yahoo-finance2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint, ...params } = req.query;

  try {
    let data;

    if (endpoint === 'quote') {
      // Batch: symbols=EURUSD=X,GC=F,...
      const symbols = params.symbols.split(',').map(s => s.trim());
      const results = await Promise.all(
        symbols.map(sym =>
          yahooFinance.quote(sym, {}, { validateResult: false })
            .then(q => ({
              symbol: sym,
              regularMarketPrice:         q.regularMarketPrice,
              regularMarketChangePercent: q.regularMarketChangePercent,
              regularMarketChange:        q.regularMarketChange,
              shortName:                  q.shortName || q.longName || sym,
              currency:                   q.currency,
              marketState:                q.marketState,
            }))
            .catch(() => ({ symbol: sym, error: true }))
        )
      );
      data = results;

    } else if (endpoint === 'chart') {
      // Historische data
      const sym      = params.symbol;
      const interval = params.interval || '1d';
      const range    = params.range;

      let period1, period2;
      if (range === 'custom') {
        period1 = new Date(params.period1 * 1000);
        period2 = new Date(params.period2 * 1000);
      } else {
        const rangeMap = {
          '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365
        };
        const days = rangeMap[range] || 30;
        period2 = new Date();
        period1 = new Date(Date.now() - days * 86400000);
      }

      const intervalMap = {
        '1m':'1m','2m':'2m','5m':'5m','15m':'15m','30m':'30m',
        '60m':'60m','1h':'60m','1d':'1d','1wk':'1wk','1mo':'1mo'
      };

      const result = await yahooFinance.chart(sym, {
        period1,
        period2,
        interval: intervalMap[interval] || '1d',
      }, { validateResult: false });

      // Formatteer naar zelfde structuur als v8/finance/chart
      data = {
        chart: {
          result: [{
            timestamp: result.quotes.map(q => Math.floor(new Date(q.date).getTime() / 1000)),
            indicators: {
              quote: [{
                close: result.quotes.map(q => q.close),
                open:  result.quotes.map(q => q.open),
                high:  result.quotes.map(q => q.high),
                low:   result.quotes.map(q => q.low),
              }]
            }
          }]
        }
      };

    } else if (endpoint === 'search') {
      const results = await yahooFinance.search(params.q, { quotesCount: 6, newsCount: 0 }, { validateResult: false });
      data = results;

    } else {
      return res.status(400).json({ error: `Onbekend endpoint: ${endpoint}` });
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);

  } catch (err) {
    console.error('Market API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
