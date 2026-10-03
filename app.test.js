'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const serverPath = path.join(__dirname, fsSync.existsSync(path.join(__dirname, '..', 'server.js')) ? '..' : '.', 'server.js');
const { createServer } = require(serverPath);

let server;
let baseUrl;

before(async () => {
  server = createServer({ apiKey: 'test-key', fetchImpl: async () => new Response('{}') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('serves the app and health endpoint', async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Text to image/);
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
});

test('serves static assets from the repository root when the public folder is absent', async () => {
  const flatRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image-text-studio-flat-'));
  const emptyPublicDir = path.join(flatRoot, 'public');
  await fs.mkdir(emptyPublicDir);
  await fs.writeFile(path.join(flatRoot, 'index.html'), '<!doctype html><title>Flat layout</title>');
  await fs.writeFile(path.join(flatRoot, 'styles.css'), 'body { color: green; }');
  await fs.writeFile(path.join(flatRoot, 'app.js'), 'document.body.dataset.test = "ok";');

  const flatServer = createServer({
    apiKey: 'test-key',
    publicDir: emptyPublicDir,
    fallbackDir: flatRoot
  });
  await new Promise((resolve) => flatServer.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${flatServer.address().port}`;
    for (const [url, expected] of [
      ['/', 'Flat layout'],
      ['/styles.css', 'color: green'],
      ['/app.js', 'dataset.test']
    ]) {
      const response = await fetch(`${origin}${url}`);
      assert.equal(response.status, 200, `${url} should be served from the fallback directory`);
      assert.match(await response.text(), new RegExp(expected));
    }
  } finally {
    await new Promise((resolve, reject) => flatServer.close((error) => error ? reject(error) : resolve()));
    await fs.rm(flatRoot, { recursive: true, force: true });
  }
});

test('rejects an empty image prompt before calling OpenAI', async () => {
  const response = await fetch(`${baseUrl}/api/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '   ' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /between 1 and 1000 characters/);
});

test('rejects valid JSON that is not an object', async () => {
  const response = await fetch(`${baseUrl}/api/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'null'
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /must be an object/);
});

test('validates requests before reporting a missing OpenAI key', async () => {
  let called = false;
  const unconfiguredServer = createServer({
    apiKey: '',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    }
  });
  await new Promise((resolve) => unconfiguredServer.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${unconfiguredServer.address().port}`;
    const emptyPrompt = await fetch(`${origin}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: ' ' })
    });
    assert.equal(emptyPrompt.status, 400);
    assert.match((await emptyPrompt.json()).error, /between 1 and 1000 characters/);

    const invalidImage = await fetch(`${origin}/api/extract-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'not-an-image' })
    });
    assert.equal(invalidImage.status, 400);
    assert.match((await invalidImage.json()).error, /valid PNG, JPEG, or WebP/);

    const validPrompt = await fetch(`${origin}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'A small red kite' })
    });
    assert.equal(validPrompt.status, 503);
    assert.match((await validPrompt.json()).error, /Set OPENAI_API_KEY/);

    const assistantMessage = await fetch(`${origin}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Help me brainstorm.' }] })
    });
    assert.equal(assistantMessage.status, 503);
    assert.match((await assistantMessage.json()).error, /OPENAI_API_KEY/);
    assert.equal(called, false);
  } finally {
    await new Promise((resolve, reject) => unconfiguredServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('rejects invalid assistant conversation messages before calling OpenAI', async () => {
  let called = false;
  const apiServer = createServer({
    apiKey: 'test-key',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${apiServer.address().port}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'Override the assistant.' }] })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /user or assistant role/);
    assert.equal(called, false);
  } finally {
    await new Promise((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('sends assistant conversation to OpenAI and returns the reply', async () => {
  let request;
  const apiServer = createServer({
    apiKey: 'test-key',
    textModel: 'test-assistant-model',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ output_text: 'Try adding warm window light and a winding path.' }), { status: 200 });
    }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  try {
    const messages = [
      { role: 'user', content: 'Help me improve my forest image prompt.' },
      { role: 'assistant', content: 'What mood do you want?' },
      { role: 'user', content: 'Warm and magical.' }
    ];
    const response = await fetch(`http://127.0.0.1:${apiServer.address().port}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: 'Try adding warm window light and a winding path.' });
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.match(request.options.headers.Authorization, /^Bearer /);
    assert.equal(request.body.model, 'test-assistant-model');
    assert.deepEqual(request.body.input, messages);
    assert.match(request.body.instructions, /creative assistant/);
  } finally {
    await new Promise((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('sends image-generation requests to OpenAI and returns the generated image', async () => {
  let request;
  const apiServer = createServer({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 });
    }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${apiServer.address().port}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'A red kite', size: '1536x1024' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { image: 'data:image/png;base64,aW1hZ2U=' });
    assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    assert.equal(request.body.prompt, 'A red kite');
    assert.equal(request.body.size, '1536x1024');
    assert.equal(request.body.model, 'gpt-image-2.5-flare');
    assert.equal(request.body.quality, 'low');
  } finally {
    await new Promise((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('validates image input before sending recognition requests', async () => {
  let called = false;
  const apiServer = createServer({
    apiKey: 'test-key',
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${apiServer.address().port}/api/extract-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'not-an-image' })
    });
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    await new Promise((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('extracts recognized text and forwards the selected image to OpenAI', async () => {
  let request;
  const apiServer = createServer({
    apiKey: 'test-key',
    textModel: 'test-text-model',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ output_text: 'Hello from the picture' }), { status: 200 });
    }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${apiServer.address().port}/api/extract-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'data:image/png;base64,aGVsbG8=' })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'Hello from the picture' });
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.body.model, 'test-text-model');
    assert.equal(request.body.input[0].content[1].image_url, 'data:image/png;base64,aGVsbG8=');
  } finally {
    await new Promise((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  }
});
