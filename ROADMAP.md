# Roadmap

1. **Gemini provider** (text and images). Built on
   `@richardmcquiston01/gemini-icon-gen` once its text version ships,
   declared as an **optional peer dependency** and loaded with a dynamic
   `import()`, so Ollama/ComfyUI-only consumers don't install the Google
   SDK. Without the peer installed, the provider returns a Result error
   naming the package to add. Subpath `./gemini`.
2. **Claude provider** (text). The Anthropic API, keyed per use (a Claude
   plan doesn't include API use). Subpath `./claude`, same optional-peer
   pattern for the SDK, or plain `fetch`.
3. **`createProviders(config)`**: build the configured providers from a
   plain object (provider name, host, model, key), so apps don't each
   write the same switch. Keys are passed in, never read from the
   environment.
4. **Model listing**: `listModels()` for Ollama (`GET /api/tags`), for a
   settings page's dropdown.

Not planned: streaming, chat history, or tool use. This package covers
one-shot "turn this into text or an image" tasks.
