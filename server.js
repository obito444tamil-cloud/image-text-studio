'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1000;
const IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      reject(new HttpError(415, 'Send this request as JSON.'));
      req.resume();
      return;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES && !tooLarge) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, 'The request is too large. Images must be 5 MB or smaller.'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'The request body must contain valid JSON.'));
      }
    });
  });
}

function validateImageDataUrl(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Choose a PNG, JPEG, or WebP image to recognize.');
  }

  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) {
    throw new HttpError(400, 'The image must be a valid PNG, JPEG, or WebP file.');
  }

  const image = Buffer.from(match[2], 'base64');
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES || image.toString('base64') !== match[2]) {
    throw new HttpError(400, 'The image must be valid and no larger than 5 MB.');
  }

  return value;
}

function extractResponseText(result) {
  if (typeof result.output_text === 'string') return result.output_text.trim();

  const text = [];
  for (const item of result.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        text.push(content.text);
      }
    }
  }
  return text.join('\n').trim();
}

async function callOpenAI(fetchImpl, apiKey, endpoint, payload) {
  let response;
  try {
    response = await fetchImpl(`https://api.openai.com/v1/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new HttpError(504, 'OpenAI took too long to respond. Please try again.');
    }
    throw new HttpError(502, 'Could not connect to OpenAI. Please try again shortly.');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new HttpError(502, 'OpenAI returned an unreadable response. Please try again.');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(503, 'The server OpenAI key is invalid or does not have access to this model.');
    }
    if (response.status === 429) {
      throw new HttpError(429, 'OpenAI usage is currently limited. Check the API account billing and limits.');
    }
    if (response.status >= 500) {
      throw new HttpError(502, 'OpenAI is temporarily unavailable. Please try again shortly.');
    }
    throw new HttpError(400, result.error?.message || 'OpenAI could not process this request.');
  }

  return result;
}

async function handleApi(req, res, options) {
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method !== 'POST' || !['/api/generate-image', '/api/extract-text'].includes(req.url)) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  if (!options.apiKey) {
    throw new HttpError(503, 'The app is not configured yet. Set OPENAI_API_KEY on the server.');
  }

  const body = await readJson(req);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'The JSON request body must be an object.');
  }
  if (req.url === '/api/generate-image') {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      throw new HttpError(400, `Enter a prompt between 1 and ${MAX_PROMPT_LENGTH} characters.`);
    }
    const size = IMAGE_SIZES.has(body.size) ? body.size : '1024x1024';
    const result = await callOpenAI(options.fetchImpl, options.apiKey, 'images/generations', {
      model: options.imageModel,
      prompt,
      size,
      quality: 'low',
      n: 1
    });
    const encodedImage = result.data?.[0]?.b64_json;
    if (typeof encodedImage !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedImage)) {
      throw new HttpError(502, 'OpenAI did not return a usable image. Please try again.');
    }
    sendJson(res, 200, { image: `data:image/png;base64,${encodedImage}` });
    return;
  }

  const image = validateImageDataUrl(body.image);
  const result = await callOpenAI(options.fetchImpl, options.apiKey, 'responses', {
    model: options.textModel,
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Transcribe all readable text in this image. Preserve the original line breaks where practical. If no text is visible, say so.'
        },
        { type: 'input_image', image_url: image }
      ]
    }],
    max_output_tokens: 1500
  });
  const text = extractResponseText(result);
  if (!text) throw new HttpError(502, 'OpenAI did not return recognized text. Please try again.');
  sendJson(res, 200, { text });
}

function createServer({
  apiKey = process.env.OPENAI_API_KEY,
  imageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare',
  textModel = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini',
  fetchImpl = globalThis.fetch
} = {}) {
  const options = { apiKey, imageModel, textModel, fetchImpl };

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );

    try {
      if (req.url === '/healthz' || req.url?.startsWith('/api/')) {
        await handleApi(req, res, options);
        return;
      }

      const asset = STATIC_FILES.get(req.url);
      if (req.method !== 'GET' || !asset) {
        sendJson(res, 404, { error: 'Not found.' });
        return;
      }
      const content = await fs.readFile(path.join(PUBLIC_DIR, asset[0]));
      res.writeHead(200, {
        'Content-Type': asset[1],
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(content);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (!(error instanceof HttpError)) {
        console.error('Request failed:', error);
      }
      sendJson(
        res,
        error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'The server could not complete this request.' }
      );
    }
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Image Text Studio is listening on port ${port}.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

module.exports = { createServer };
