# pi-inspect-image-stream

A minimal fork of `pi-inspect-image` for custom OpenAI-compatible vision APIs that require `stream: true` and return SSE.

## What changed

- Sends `stream: true` by default when `visionConfig.baseUrl` is set
- Parses `text/event-stream` responses from OpenAI-compatible providers
- Keeps the original `inspect_image` tool and `/setup-vision` command behavior

## Install

Install from GitHub:

```bash
pi install https://github.com/<your-user>/pi-inspect-image-stream
```

For local development:

```bash
pi install ./pi-inspect-image-stream
```

If you already have `npm:pi-inspect-image` installed, remove or disable it first to avoid duplicate `inspect_image` tools.

## Config

Add this to `.pi/settings.json` in the project where you use it:

```json
{
  "visionConfig": {
    "provider": "custom",
    "baseUrl": "https://your-base-url",
    "model": "gpt-5.4"
  }
}
```

Notes:
- `baseUrl` should be the API root without the trailing `/v1`
- Set `visionConfig.stream` explicitly if you need to override the default

## Optional

```json
{
  "visionConfig": {
    "provider": "custom",
    "baseUrl": "https://your-base-url",
    "model": "gpt-5.4",
    "stream": true,
    "maxTokens": 4096
  }
}
```
