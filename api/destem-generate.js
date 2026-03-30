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

// Elke feed heeft een label dat meegestuurd wordt naar het model
// zodat het weet van welke bron en categorie het artikel komt.
const FEEDS = [
  { url: 'https://www.vrt.be/vrtnws/nl.rss.articles.xml',              label: 'vrt',              tag: 'binnenlands' },
  { url: 'https://www.hln.be/home/rss.xml',                            label: 'hln',              tag: 'binnenlands' },
  { url: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',  label: 'wsj',              tag: 'economie'    },
  { url: 'https://www.euronews.com/rss?format=mrss&level=theme&name=news', label: 'euronews',     tag: 'internationaal' },
  { url: 'https://www.politico.eu/section/politics/feed/',             label: 'politico',         tag: 'politiek'    },
  { url: 'https://www.politico.eu/section/opinion/feed/',              label: 'politico-opinion', tag: 'politiek'    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Stap 1 — RSS ophalen
// ─────────────────────────────────────────────────────────────────────────────
async function fetchItems({ url, label, tag }) {
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
      source: label,
      tag,
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 2 — Groq: verhalen + script in één call
// ─────────────────────────────────────────────────────────────────────────────
// ─── Constanten ──────────────────────────────────────────────────────────────
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL      = 'llama-3.3-70b-versatile';
const MAX_TOKENS = 1200;   // 950 was te krap voor 450 woorden + JSON
const TIMEOUT_MS = 45_000;
const MAX_ITEMS  = 80;

// ─── Foutklasse ───────────────────────────────────────────────────────────────
class GroqError extends Error {
  constructor(statusCode, message) {
    super(`Groq ${statusCode}: ${message}`);
    this.statusCode = statusCode;
  }
}

// ─── Promptopbouw ─────────────────────────────────────────────────────────────
function buildPrompt(items, dagNaam, datumStr) {
  const artikelsJson = JSON.stringify(
    items.slice(0, MAX_ITEMS).map((a, i) => ({
      i,
      t:   a.title,
      d:   a.desc,
      s:   a.source,
      tag: a.tag,
    }))
  );

  return `Je bent een Vlaamse radionieuwsredacteur. Vandaag is het ${dagNaam} ${datumStr}.

Je krijgt nieuwsartikels uit verschillende bronnen. Elk artikel heeft een "tag" \
(economie / politiek / binnenlands / internationaal) als hint.

Kies exact 5 artikels volgens deze vaste verdeling:
- rank 1 & 2 : ECONOMIE (internationaal) — marktnieuws, handelsbeleid, bedrijven, centrale banken, energie, sancties
- rank 3 & 4 : POLITIEK (internationaal) — geopolitiek, diplomatie, oorlog, verkiezingen, EU-beleid
- rank 5     : BINNENLANDS (België) — Belgisch nieuws, politiek of economisch

Strikt verboden: sport, entertainment, lifestyle, dieren, natuur — tenzij directe economische of politieke impact.
Als een categorie onvoldoende artikels heeft, kies het best beschikbare alternatief binnen politiek/economie.

VERTALING: Alle titels en samenvattingen MOETEN in correct, vloeiend Nederlands zijn — vertaal altijd vanuit het Engels of Frans.

Geef je antwoord in exact dit formaat, zonder extra titels, labels of uitleg:

<stories>
[{"rank":1,"category":"economie","title":"[NL]","summary":"[NL, max 20 woorden]","source":"[kopieer s-veld]"},{"rank":2,"category":"economie","title":"[NL]","summary":"[NL, max 20 woorden]","source":"[kopieer s-veld]"},{"rank":3,"category":"politiek","title":"[NL]","summary":"[NL, max 20 woorden]","source":"[kopieer s-veld]"},{"rank":4,"category":"politiek","title":"[NL]","summary":"[NL, max 20 woorden]","source":"[kopieer s-veld]"},{"rank":5,"category":"binnenlands","title":"[NL]","summary":"[NL, max 20 woorden]","source":"[kopieer s-veld]"}]
</stories>Goedeavond, hier is uw DeStem avondbriefing van ${dagNaam} ${datumStr}. [verder radioscript in het Nederlands]

Regels voor het radioscript (begint onmiddellijk na </stories>, geen witregel, geen header of label):
Vloeiend journalistiek Nederlands, ±450 woorden (~3 min). Bespreek verhalen in volgorde van rank.
Gebruik overgangszinnen. Geen koppen of opsommingen. Sluit af met een korte afsluiting.

Artikels (formaat: i=index, t=titel, d=beschrijving, s=bronlabel, tag=categoriehint):
${artikelsJson}`;
}

// ─── Responsparsing ───────────────────────────────────────────────────────────
function parseResponse(raw) {
  // Extraheer <stories>…</stories>
  const storiesMatch = raw.match(/<stories>([\s\S]*?)<\/stories>/);
  let stories = [];

  if (storiesMatch) {
    const jsonText = storiesMatch[1].trim();
    try {
      stories = JSON.parse(jsonText);
    } catch {
      // Fallback: probeer array-blok te redden via eerste '[' en laatste ']'
      const start = jsonText.indexOf('[');
      const end   = jsonText.lastIndexOf(']');
      if (start !== -1 && end !== -1) {
        try { stories = JSON.parse(jsonText.slice(start, end + 1)); } catch { /* blijft [] */ }
      }
    }
  }

  if (!Array.isArray(stories) || stories.length !== 5) {
    throw new Error(`Verwacht 5 stories, kreeg ${Array.isArray(stories) ? stories.length : 'geen geldige array'}`);
  }

  // Script = alles na </stories>
  const script = raw.replace(/<stories>[\s\S]*?<\/stories>/, '').trim();
  if (!script) throw new Error('Groq gaf geen radioscript terug');

  return { stories, script };
}

// ─── Hoofdfunctie ─────────────────────────────────────────────────────────────
async function generateContent(items, groqKey) {
  const now      = new Date();
  const dagNaam  = now.toLocaleDateString('nl-BE', { weekday: 'long' });
  const datumStr = now.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = buildPrompt(items, dagNaam, datumStr);

  const res = await fetch(GROQ_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model:       MODEL,
      temperature: 0.35,
      max_tokens:  MAX_TOKENS,
      messages:    [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new GroqError(res.status, err?.error?.message ?? 'onbekende fout');
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content?.trim() ?? '';

  return parseResponse(raw);
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
  if (!b64) throw new Error('Gemini TTS: geen audio in response');

  // Decodeer base64 → raw PCM bytes
  const binary = atob(b64);
  const pcm    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pcm[i] = binary.charCodeAt(i);

  // Gemini geeft raw PCM (24kHz, 16-bit, mono) — voeg WAV header toe zodat browsers het kunnen afspelen
  const sampleRate    = 24000;
  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = pcm.length;
  const buffer        = new ArrayBuffer(44 + dataSize);
  const view          = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0,  'RIFF');
  view.setUint32(4,  36 + dataSize, true);
  writeStr(8,  'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16,            true);
  view.setUint16(20, 1,             true); // PCM
  view.setUint16(22, numChannels,   true);
  view.setUint32(24, sampleRate,    true);
  view.setUint32(28, byteRate,      true);
  view.setUint16(32, blockAlign,    true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const wav = new Uint8Array(buffer);
  wav.set(pcm, 44);

  return { bytes: wav, mime: 'audio/wav' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stap 4 — Vercel Blob
// ─────────────────────────────────────────────────────────────────────────────
async function saveBriefing({ audioBytes, mime, script, stories, date, voice }) {
  const dateStr   = date.toISOString().slice(0, 10);
  const audioBlob = await put(`destem/${dateStr}.wav`, audioBytes, {
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
    const allItems = (await Promise.all(FEEDS.map(fetchItems))).flat();
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
