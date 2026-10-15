# Roadmap

Done: Ollama and ComfyUI (0.1.0), Gemini text and image edits (`./gemini`),
Claude text (`./claude`), OpenAI text and image edits (`./openai`),
Replicate image edits (`./replicate`).

1. **`createProviders(config)`**: build the configured providers from a
   plain object (provider name, host, model, key), so apps don't each
   write the same switch. Keys are passed in, never read from the
   environment.
2. **Model listing**: `listModels()` for Ollama (`GET /api/tags`), for a
   settings page's dropdown.
3. **Grok** (`./grok`): `GrokTextGenerator` and `GrokImageGenerator`
   (xAI). The API is OpenAI-compatible, so reuse the OpenAI provider with a
   different base URL where possible (`./openai` pins the OpenAI endpoint
   today, so it would take a `baseUrl` option).

Each new provider follows "Adding a provider" in `CLAUDE.md`: its own
subpath, tests against a fake `fetch`, and a changeset.

Not planned: streaming, chat history, or tool use. This package covers
one-shot "turn this into text or an image" tasks.
