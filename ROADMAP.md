# Roadmap

Done: Ollama and ComfyUI (0.1.0), Gemini text and image edits (`./gemini`).

1. **Claude provider** (text). The Anthropic API, keyed per use (a Claude
   plan doesn't include API use). Subpath `./claude`, same optional-peer
   pattern for the SDK, or plain `fetch`.
2. **`createProviders(config)`**: build the configured providers from a
   plain object (provider name, host, model, key), so apps don't each
   write the same switch. Keys are passed in, never read from the
   environment.
3. **Model listing**: `listModels()` for Ollama (`GET /api/tags`), for a
   settings page's dropdown.

Not planned: streaming, chat history, or tool use. This package covers
one-shot "turn this into text or an image" tasks.
