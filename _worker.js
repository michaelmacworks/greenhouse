const MAX_CONTEXT_CHARS = 120_000;
const DATA_STORE_KEY   = 'greenhouse_story';
const DATA_AUTH        = 'Greenhouse2024!'; // matches Login.jsx

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function schemaToExample(schema) {
  if (!schema || typeof schema !== 'object') return '""';
  if (schema.type === 'string') return schema.enum ? `"${schema.enum[0]}"` : '"..."';
  if (schema.type === 'integer') return '0';
  if (schema.type === 'boolean') return 'false';
  if (schema.type === 'array') {
    const item = schema.items ? schemaToExample(schema.items) : '{}';
    return `[${item}]`;
  }
  if (schema.type === 'object' && schema.properties) {
    const fields = Object.entries(schema.properties)
      .map(([k, v]) => `"${k}": ${schemaToExample(v)}`)
      .join(', ');
    return `{ ${fields} }`;
  }
  return '""';
}

function truncateContext(context) {
  if (context.length <= MAX_CONTEXT_CHARS) return context;
  const parts = context.split(/(---[^\n]+---)/);
  if (parts.length <= 1) {
    const half = Math.floor(MAX_CONTEXT_CHARS / 2);
    return context.slice(0, half) + '\n\n[...truncated...]\n\n' + context.slice(-half);
  }
  const separators = parts.filter((_, i) => i % 2 === 1);
  const bodies = parts.filter((_, i) => i % 2 === 0);
  const budget = Math.floor(MAX_CONTEXT_CHARS / Math.max(1, bodies.filter(b => b.trim()).length));
  const result = [];
  for (let i = 0; i < bodies.length; i++) {
    if (separators[i - 1]) result.push(separators[i - 1]);
    const body = bodies[i];
    if (body.length <= budget) {
      result.push(body);
    } else {
      const half = Math.floor(budget / 2);
      result.push(body.slice(0, half) + '\n\n[...truncated...]\n\n' + body.slice(-half));
    }
  }
  return result.join('');
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// After Claude returns chapters, scan the document for each chapter title
// and inject the real word count from the surrounding text.
function injectWordCounts(chapters, storyContext) {
  if (!Array.isArray(chapters) || chapters.length === 0) return chapters;

  // Build a flat list of all heading positions in the document
  const headingRegex = /(?:^|\n)((?:chapter|ch\.?|part)\s+[\w\d]+[^\n]*|#{1,3}\s+[^\n]+|[A-Z][^\n]{3,60}(?=\n))/gim;
  const headings = [...storyContext.matchAll(headingRegex)].map(m => ({
    raw: m[1].trim(),
    index: m.index + m[0].length,
  }));

  return chapters.map(ch => {
    const title = (ch.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (!title) return ch;

    // Find the heading in the document that best matches this chapter title
    let bestMatch = null;
    let bestScore = 0;
    for (let i = 0; i < headings.length; i++) {
      const raw = headings[i].raw.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      // Simple word-overlap score
      const titleWords = title.split(/\s+/);
      const rawWords = raw.split(/\s+/);
      const overlap = titleWords.filter(w => w.length > 2 && rawWords.includes(w)).length;
      const score = overlap / Math.max(titleWords.length, 1);
      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        bestMatch = { heading: headings[i], nextIndex: i + 1 < headings.length ? headings[i + 1].index : storyContext.length };
      }
    }

    if (bestMatch) {
      const body = storyContext.slice(bestMatch.heading.index, bestMatch.nextIndex);
      const wc = countWords(body);
      if (wc > 30) return { ...ch, wordCount: wc };
    }

    return ch;
  });
}

async function callGemini(env, systemPrompt, userContent, wantsJson) {
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userContent }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: wantsJson ? 4096 : 1500,
      ...(wantsJson ? { responseMimeType: 'application/json' } : {}),
    },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini API error ${res.status}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

async function callClaude(env, systemPrompt, userContent, wantsJson) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: wantsJson ? 4096 : 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API error ${res.status}`);
  return data?.content?.find(c => c.type === 'text')?.text?.trim() ?? '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data' && request.method === 'POST') {
      const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '');
      if (auth !== DATA_AUTH) return json({ error: 'Unauthorized' }, 401);
      if (!env.GREENHOUSE_DATA) return json({ error: 'Storage not configured. Add a KV namespace binding named GREENHOUSE_DATA in your Cloudflare Pages settings.' }, 503);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

      if (body.action === 'load') {
        try {
          const raw = await env.GREENHOUSE_DATA.get(DATA_STORE_KEY);
          return json({ data: raw ? JSON.parse(raw) : null });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      if (body.action === 'save' && body.data) {
        try {
          await env.GREENHOUSE_DATA.put(DATA_STORE_KEY, JSON.stringify(body.data));
          return json({ ok: true });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      return json({ error: 'Unknown action' }, 400);
    }

    if (url.pathname === '/api/ai' && request.method === 'POST') {
      if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
        return json({ error: { message: 'No AI API key configured in Cloudflare.' } }, 500);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: { message: 'Invalid JSON request body.' } }, 400);
      }

      const { system = '', userPrompt = '', storyContext = '', responseFormat } = payload || {};

      if (!userPrompt.trim()) {
        return json({ error: { message: 'Missing user prompt.' } }, 400);
      }

      const wantsJson = responseFormat?.type === 'json_schema';

      let jsonInstruction = '';
      if (wantsJson && responseFormat.schema) {
        const example = schemaToExample(responseFormat.schema);
        jsonInstruction = [
          `You MUST respond with a single valid JSON object that exactly matches this structure — no markdown, no explanation, no extra keys:`,
          example,
          `Rules:`,
          `- Every key shown above must be present in your response.`,
          `- Arrays may be empty [] if there is nothing to extract, but the key must exist.`,
          `- For string fields, use "" if unknown rather than omitting the field.`,
          `- Do not add any keys not shown in the structure above.`,
          `- For chapter "wordCount" set 0 — the server will compute this automatically.`,
          `- For location "type": "colony"=settlement/outpost, "region"=area/zone/territory, "facility"=lab/base/installation, "station"=space station/port, "ship"=vessel. Default "region".`,
        ].join('\n');
      } else if (wantsJson) {
        jsonInstruction = 'Return ONLY a valid JSON object. No markdown fences, no explanation.';
      }

      const systemPrompt = [system, jsonInstruction].filter(Boolean).join('\n\n');
      const safeContext = truncateContext(storyContext);
      const userContent = `Story context (confidential — do not quote unless asked):\n${safeContext}\n\n---\n\nRequest: ${userPrompt}`;

      try {
        let text;
        if (wantsJson) {
          text = await callClaude(env, systemPrompt, userContent, wantsJson);
        } else if (env.GEMINI_API_KEY) {
          text = await callGemini(env, systemPrompt, userContent, wantsJson);
        } else {
          text = await callClaude(env, systemPrompt, userContent, wantsJson);
        }

        if (wantsJson) {
          text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

          // Post-process: inject real word counts by scanning the document
          try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed.chapters)) {
              parsed.chapters = injectWordCounts(parsed.chapters, storyContext);
            }
            text = JSON.stringify(parsed);
          } catch {
            // JSON parse failed — return raw text, let the client handle it
          }
        }

        return json({ text });
      } catch (err) {
        return json({ error: { message: err.message } }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
