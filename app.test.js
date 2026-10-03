'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createServer } = require('../server');

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
