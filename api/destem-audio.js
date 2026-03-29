/**
 * DeStem — GET /api/destem-audio
 *
 * Proxiet het audio-bestand vanuit Vercel Blob naar de browser.
 * Dit vermijdt CORS- en mixed-content problemen bij directe Blob-URL's.
 *
 * Query params:
 *   ?date=YYYY-MM-DD   — welke dag (verplicht)
 *
 * Geeft de WAV-bytes terug met correcte headers voor audio streaming.
 */

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const storeUrl = process.env.BLOB_STORE_URL;
  if (!storeUrl) {
    return res.status(500).json({ error: 'BLOB_STORE_URL omgevingsvariabele ontbreekt' });
  }

  const dateStr = req.query?.date;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Verplichte query param ?date=YYYY-MM-DD ontbreekt of ongeldig' });
  }

  const blobUrl = `${storeUrl.replace(/\/$/, '')}/destem/${dateStr}.wav`;

  try {
    const upstream = await fetch(blobUrl, {
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Audio bestand niet gevonden voor ${dateStr}`,
      });
    }

    const contentLength = upstream.headers.get('content-length');
    const rangeHeader   = req.headers['range'];

    // Ondersteun Range requests (voor scrubben in de browser)
    if (rangeHeader && contentLength) {
      const total = parseInt(contentLength, 10);
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : total - 1;
      const chunk = end - start + 1;

      // Haal alleen het gewenste stuk op via Blob (Range passthrough)
      const rangeRes = await fetch(blobUrl, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(30000),
      });

      res.status(206);
      res.setHeader('Content-Range',  `bytes ${start}-${end}/${total}`);
      res.setHeader('Accept-Ranges',  'bytes');
      res.setHeader('Content-Length', chunk);
      res.setHeader('Content-Type',   'audio/wav');
      res.setHeader('Cache-Control',  'public, max-age=86400');

      const buf = Buffer.from(await rangeRes.arrayBuffer());
      return res.end(buf);
    }

    // Geen Range: stuur de volledige file
    res.status(200);
    res.setHeader('Content-Type',   'audio/wav');
    res.setHeader('Accept-Ranges',  'bytes');
    res.setHeader('Cache-Control',  'public, max-age=86400');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);

  } catch (err) {
    console.error('[DeStem audio proxy]', err);
    return res.status(500).json({ error: err.message });
  }
}
