/**
 * DeStem — Cron job: genereert elke ochtend een audio-briefing van 3 minuten.
 *
 * Stappen:
 *  1. Haal de nieuwsfeed op (RSS via rss2json)
 *  2. Laat Groq de 5 belangrijkste verhalen selecteren + script schrijven
 *  3. Converteer het script naar audio via Gemini 2.5 Flash TTS
 *  4. Sla het resultaat op in Vercel Blob
 *
 * Vercel Cron: dagelijks om 06:00 BE-tijd (UTC+1/+2 → 05:00 UTC in zomer)
 * Stel in vercel.json in: "crons": [{ "path": "/api/destem-generate", "schedule": "0 5 * * *" }]
 */

import { put, list } from '@vercel/blob';

const RSS2JSON_BASE =
  'https://api.rss2json.com/v1/api.json?api_key=goxrkjvrqv2dqaaj0mybmnl0vyjxhqccxlh906cv&count=30&rss_url=';

const FEED_URLS = [
  'https://www.vrt.be/vrtnws/nl.rss.articles.xml',
  'https://www.hln.be/home/rss.xml',
  'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
  'https://www.euronews.com/rss?format=mrss&level=theme&name=news',
];

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
      title: (i.title || '').trim(),
      desc:  (i.description || i.content || '').replace(/<[^>]*>/g, '').trim().slice(0, 300),
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 2 — Groq: selecteer 5 verhalen + schrijf script
// ─────────────────────────────────────────────────────────────────────────────
async function generateScript(items, groqKey) {
  const artikelsJson = JSON.stringify(
    items.slice(0, 60).map((a, i) => ({ i, title: a.title, desc: a.desc }))
  );

  const prompt = `Je bent een Vlaamse radionieuwslezer. Je krijgt een lijst nieuwsartikels van vandaag.

Taak:
1. Kies de 5 meest nieuwswaardige verhalen. Geef prioriteit aan politiek en economie boven lokaal nieuws, sport of entertainment. Sport mag NIET worden opgenomen.
2. Schrijf een vloeiend, journalistiek Nederlandstalig radioscript van ongeveer 3 minuten (±450 woorden). Gebruik natuurlijke overgangszinnen tussen de verhalen. Begin met een korte begroeting zoals "Goedemorgen, hier is uw DeStem briefing van [dag] [datum]." Eindig met een afsluiting. Gebruik geen koppen of opsommingen — alleen doorlopende tekst.

Geef ALLEEN het script terug, geen uitleg of opmaak.

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
      temperature: 0.4,
      max_tokens:  700,
      messages:    [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq ${res.status}: ${err?.error?.message || 'onbekende fout'}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 3 — Gemini TTS: script → audio (MP3)
// ─────────────────────────────────────────────────────────────────────────────
async function textToSpeech(script, geminiKey) {
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
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Aoede' }, // heldere, neutrale stem
            },
          },
        },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini TTS ${res.status}: ${JSON.stringify(err)}`);
  }

  const data   = await res.json();
  const b64    = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  const mime   = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || 'audio/mp3';

  if (!b64) throw new Error('Gemini TTS: geen audio in response');

  // Decodeer base64 → Uint8Array
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return { bytes, mime };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 4 — Sla op in Vercel Blob
// ─────────────────────────────────────────────────────────────────────────────
async function saveBriefing(audioBytes, mime, script, date) {
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD

  // Sla audio op
  const audioBlob = await put(`destem/${dateStr}.mp3`, audioBytes, {
    access:      'public',
    contentType: mime,
    addRandomSuffix: false,
  });

  // Sla metadata + script op als JSON
  const meta = {
    date:    dateStr,
    audioUrl: audioBlob.url,
    script,
    generatedAt: new Date().toISOString(),
  };

  await put(`destem/${dateStr}.json`, JSON.stringify(meta), {
    access:      'public',
    contentType: 'application/json',
    addRandomSuffix: false,
  });

  return meta;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Vercel Cron stuurt een GET; beveilig met een geheim token om misbruik te voorkomen
  const authHeader = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const GROQ_API_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_API_KEY)   return res.status(500).json({ error: 'GROQ_API_KEY ontbreekt' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY ontbreekt' });

  const today = new Date();

  try {
    // 1. Haal feeds op
    const allItems = (
      await Promise.all(FEED_URLS.map(fetchItems))
    ).flat();

    if (allItems.length < 5) {
      return res.status(502).json({ error: 'Te weinig artikels opgehaald' });
    }

    // 2. Script genereren via Groq
    const script = await generateScript(allItems, GROQ_API_KEY);
    if (!script) return res.status(500).json({ error: 'Leeg script van Groq' });

    // 3. Audio genereren via Gemini TTS
    const { bytes, mime } = await textToSpeech(script, GEMINI_API_KEY);

    // 4. Opslaan
    const meta = await saveBriefing(bytes, mime, script, today);

    return res.status(200).json({ ok: true, ...meta });
  } catch (err) {
    console.error('[DeStem generate]', err);
    return res.status(500).json({ error: err.message });
  }
}
