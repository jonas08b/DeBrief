/**
 * DeStem — Cron job: genereert elke ochtend een audio-briefing van 3 minuten.
 *
 * Stappen:
 *  1. Haal de nieuwsfeed op (RSS via rss2json)
 *  2. Groq: selecteer 5 verhalen als JSON + schrijf radioscript (één call)
 *  3. Gemini 2.5 Flash TTS: script → audio (MP3)
 *  4. Sla alles op in Vercel Blob
 *
 * Vercel Cron: dagelijks om 05:00 UTC (= 07:00 CEST / 06:00 CET)
 * vercel.json: "crons": [{ "path": "/api/destem-generate", "schedule": "0 5 * * *" }]
 *
 * Env vars:
 *   GROQ_API_KEY            — Groq Cloud
 *   GEMINI_API_KEY          — Google AI Studio
 *   BLOB_READ_WRITE_TOKEN   — Vercel Blob
 *   CRON_SECRET             — (optioneel) Bearer token
 */

import { put } from '@vercel/blob';

const RSS2JSON_BASE =
  'https://api.rss2json.com/v1/api.json?api_key=goxrkjvrqv2dqaaj0mybmnl0vyjxhqccxlh906cv&count=30&rss_url=';

const FEED_URLS = [
  'https://www.vrt.be/vrtnws/nl.rss.articles.xml',
  'https://www.hln.be/home/rss.xml',
  'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
  'https://www.euronews.com/rss?format=mrss&level=theme&name=news',
];

export const VOICES = {
  Aoede:  'Aoede',
  Charon: 'Charon',
  Fenrir: 'Fenrir',
  Kore:   'Kore',
  Puck:   'Puck',
};

// ─────────────────────────────────────────────────────────────────────────────
// Stap 1 — RSS ophalen
// ─────────────────────────────────────────────────────────────────────────────
async function fetchItems(url) {
  try {
    const res = await fetch(RSS2JSON_BASE + encodeURIComponent(url), {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== 'ok' || !Array.isArray(data.items)) return [];
    return data.items.map((i) => ({
      title:  (i.title || '').trim(),
      desc:   (i.description || i.content || '').replace(/<[^>]*>/g, '').trim().slice(0, 300),
      source: new URL(url).hostname.replace('www.', '').split('.')[0],
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 2 — Groq: verhalen + script in één call
// ─────────────────────────────────────────────────────────────────────────────
async function generateContent(items, groqKey) {
  const now      = new Date();
  const dagNaam  = now.toLocaleDateString('nl-BE', { weekday: 'long' });
  const datumStr = now.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' });

  const artikelsJson = JSON.stringify(
    items.slice(0, 60).map((a, i) => ({ i, t: a.title, d: a.desc, s: a.source }))
  );

  const prompt = `Je bent een Vlaamse radionieuwsredacteur. Vandaag is het ${dagNaam} ${datumStr}.

Je krijgt nieuwsartikels. Geef je antwoord in twee delen:

DEEL 1 — Verhalen (JSON tussen <stories>…</stories>):
Kies de 5 meest nieuwswaardige artikels. Prioriteit: politiek en economie gaan altijd vóór regionaal nieuws of entertainment. Sport mag NIET worden opgenomen.
Geef voor elk:
  rank (1–5), title (correct Nederlands, vertaal indien nodig), summary (max 25 woorden, kernboodschap), source (kopieer "s"-veld)

<stories>
[{"rank":1,"title":"…","summary":"…","source":"…"},…]
</stories>

DEEL 2 — Radioscript (direct na </stories>, geen extra uitleg):
Vloeiend journalistiek script in het Nederlands, ±450 woorden (~3 min).
Begin: "Goedemorgen, hier is uw DeStem briefing van ${dagNaam} ${datumStr}."
Gebruik overgangszinnen. Geen koppen of opsommingen. Sluit af met een korte afsluiting.

Artikels:
${artikelsJson}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model:       'llama-3.3-70b-versatile',
      temperature: 0.35,
      max_tokens:  950,
      messages:    [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq ${res.status}: ${err?.error?.message || 'onbekende fout'}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content?.trim() || '';

  // Extraheer stories
  let stories = [];
  const m = raw.match(/<stories>([\s\S]*?)<\/stories>/);
  if (m) {
    try { stories = JSON.parse(m[1].trim()); } catch { stories = []; }
  }

  // Script = alles na </stories>
  const script = raw.replace(/<stories>[\s\S]*?<\/stories>/, '').trim();
  if (!script) throw new Error('Groq gaf geen script terug');

  return { stories, script };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 3 — Gemini TTS
// ─────────────────────────────────────────────────────────────────────────────
async function textToSpeech(script, geminiKey, voiceName = 'Aoede') {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: script }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
        },
      }),
      signal: AbortSignal.timeout(90000),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini TTS ${res.status}: ${JSON.stringify(err)}`);
  }

  const json = await res.json();
  const b64  = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  const mime = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || 'audio/mp3';
  if (!b64) throw new Error('Gemini TTS: geen audio in response');

  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 4 — Vercel Blob
// ─────────────────────────────────────────────────────────────────────────────
async function saveBriefing({ audioBytes, mime, script, stories, date, voice }) {
  const dateStr   = date.toISOString().slice(0, 10);
  const audioBlob = await put(`destem/${dateStr}.mp3`, audioBytes, {
    access: 'public', contentType: mime, addRandomSuffix: false,
  });

  const meta = {
    date:        dateStr,
    audioUrl:    audioBlob.url,
    script,
    stories,
    voice,
    generatedAt: new Date().toISOString(),
  };

  await put(`destem/${dateStr}.json`, JSON.stringify(meta, null, 2), {
    access: 'public', contentType: 'application/json', addRandomSuffix: false,
  });

  return meta;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const GROQ_API_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GROQ_API_KEY)   return res.status(500).json({ error: 'GROQ_API_KEY ontbreekt' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY ontbreekt' });

  // Optionele stem via query param (?voice=Kore) — handig voor handmatig testen
  const voice = VOICES[req.query?.voice] ? req.query.voice : 'Aoede';

  try {
    const allItems = (await Promise.all(FEED_URLS.map(fetchItems))).flat();
    if (allItems.length < 5) return res.status(502).json({ error: 'Te weinig artikels' });

    const { stories, script } = await generateContent(allItems, GROQ_API_KEY);
    const { bytes, mime }     = await textToSpeech(script, GEMINI_API_KEY, voice);
    const meta                = await saveBriefing({ audioBytes: bytes, mime, script, stories, date: new Date(), voice });

    return res.status(200).json({ ok: true, storiesCount: stories.length, ...meta });
  } catch (err) {
    console.error('[DeStem generate]', err);
    return res.status(500).json({ error: err.message });
  }
}
