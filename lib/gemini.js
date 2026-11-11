// Alt-text generation with Gemini 2.5 Flash (text/vision) via the PAID API.
// Never the free AI Studio tier: these are merchants' product images.
// Never Gemini 2.5 Flash Image (the generation model — wrong tool, ~100x price).
// Rules (from the builder brief): one plain sentence, ~125 characters max,
// no "image of" prefix, no keyword stuffing, never invent details that are
// not visible in the image. Logos/icons/decorative images get no description.
// If the model cannot tell what the image is, it goes to the review queue
// (status 'uncertain') — never a guess.
// API key comes from GEMINI_API_KEY only. No key = not configured, never fake.

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT = `Describe this product image in one plain sentence, no more than 125 characters.
Do not start with "image of". Do not add keywords, prices, or details you cannot see in the image.
If the image is a logo, an icon, or a decorative element, reply with exactly the word DECORATIVE.
If you cannot tell what the image shows, reply with exactly the word UNCERTAIN.
Otherwise reply with only the description and nothing else.`;

/**
 * Generate alt text for one image URL.
 * Returns { status: 'generated', alt } | { status: 'decorative' } |
 * { status: 'uncertain' }. Throws on API errors (bad key, rate limit, ...).
 */
export async function generateAltText(imageUrl, apiKey) {
  if (!apiKey) {
    const e = new Error('Gemini is not configured. Set GEMINI_API_KEY to write alt text.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  // Fetch the image bytes (same fetch path a browser would use; 15s cap, 4MB cap).
  let res;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    res = await fetch(imageUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36' },
    });
    clearTimeout(t);
  } catch (e) {
    const err = new Error(`Could not download the image to describe it: ${String(e).slice(0, 200)}`);
    err.code = 'IMAGE_FETCH_FAILED';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Could not download the image (HTTP ${res.status}).`);
    err.code = 'IMAGE_FETCH_FAILED';
    throw err;
  }
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) {
    const err = new Error('That link did not return an image file.');
    err.code = 'IMAGE_FETCH_FAILED';
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) {
    const err = new Error('Image is larger than 4MB, skipped.');
    err.code = 'IMAGE_TOO_LARGE';
    throw err;
  }

  let data;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const apiRes = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mime, data: buf.toString('base64') } },
        ] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 80 },
      }),
    });
    clearTimeout(t);
    data = await apiRes.json();
    if (!apiRes.ok) {
      const msg = (data && data.error && data.error.message) || `Gemini API returned HTTP ${apiRes.status}`;
      const err = new Error(msg.slice(0, 300));
      err.code = apiRes.status === 429 ? 'RATE_LIMITED' : 'GEMINI_ERROR';
      err.status = apiRes.status;
      throw err;
    }
  } catch (e) {
    if (e.code) throw e;
    const err = new Error(`Gemini request failed: ${String(e).slice(0, 200)}`);
    err.code = 'GEMINI_ERROR';
    throw err;
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
  if (!text) {
    return { status: 'uncertain' };
  }
  if (/^decorative$/i.test(text)) return { status: 'decorative' };
  if (/^uncertain$/i.test(text)) return { status: 'uncertain' };
  // One plain sentence, ~125 chars max: cut at a word boundary if longer.
  let alt = text.replace(/\s+/g, ' ').trim();
  if (alt.length > 125) {
    alt = alt.slice(0, 122).replace(/\s+\S*$/, '').trim();
  }
  if (!alt) return { status: 'uncertain' };
  return { status: 'generated', alt };
}
