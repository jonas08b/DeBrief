/**
 * DeStem — GET /api/destem-audio
 *
 * Stream-proxy voor het WAV-bestand vanuit Vercel Blob.
 * Ondersteunt Range requests (scrubben in de browser).
 *
 * Query params:
 *   ?date=YYYY-MM-DD   — verplicht
 */

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const storeUrl = process.env.BLOB_STORE_URL;
  if (!storeUrl) {
    return res.status(500).json({ error: 'BLOB_STORE_URL ontbreekt' });
  }

  const dateStr = req.query?.date;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Verplichte query param ?date=YYYY-MM-DD ontbreekt' });
  }

  const blobUrl = `${storeUrl.replace(/\/$/, '')}/destem/${dateStr}.wav`;

  try {
    const rangeHeader = req.headers['range'];

    const upstream = await fetch(blobUrl, {
      headers: rangeHeader ? { Range: rangeHeader } : {},
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({
        error: `Audio niet gevonden voor ${dateStr}`,
      });
    }

    // Kopieer relevante headers
    res.status(upstream.status);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const forward = ['content-length', 'content-range'];
    for (const h of forward) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    // Stream door — geen arrayBuffer() buffering
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const ok = res.write(Buffer.from(value));
        if (!ok) await new Promise(r => res.once('drain', r));
      }
      res.end();
    };

    await pump();

  } catch (err) {
    console.error('[DeStem audio proxy]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
}
