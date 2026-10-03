# Canvas — Image & Text Studio

A small Node.js app with an AI creative assistant, image generation from text,
and text recognition from uploaded images. The browser never receives the
OpenAI API key. Uploaded images are sent to OpenAI for recognition.

## Run locally

Requires Node.js 18 or later and an OpenAI API key with access to the configured
models.

```powershell
$env:OPENAI_API_KEY = "your-api-key"
npm start
```

Open <http://localhost:3000>. Image generation defaults to OpenAI's
`gpt-image-2.5-flare` fast image model at low quality for quicker results and
lower generation cost. The creative assistant and image-text recognition use
the Responses API with `gpt-4.1-mini` by default. To use another model, set
`OPENAI_IMAGE_MODEL` or `OPENAI_TEXT_MODEL` in the server environment. Never
put the API key in `public/app.js` or commit it to source control.

## Test

The test suite uses Node's built-in test runner and mocked OpenAI responses; it
does not need an API key or make paid API requests.

```powershell
npm test
```

## Deploy on Render

The included `render.yaml` defines a standalone Render web service. Push the
project files to the root of a GitHub repository, then in Render choose
**New > Blueprint** and select `render.yaml`. Review and deploy the
service, then enter the OpenAI API key when Render prompts for the
`OPENAI_API_KEY` environment variable. The key must be kept in Render's
environment settings, not committed to the repository.

After deployment, open the service's HTTPS URL and confirm `/healthz` returns
`{"status":"ok"}`. Image creation and recognition use OpenAI's API and may
incur charges, as can assistant messages and image recognition. Check your API
account's model access, billing, and usage limits before sharing the public
URL. An OpenAI API key is separate from a ChatGPT subscription.
