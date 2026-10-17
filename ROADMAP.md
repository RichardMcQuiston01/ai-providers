# Roadmap

Done: Ollama and ComfyUI (0.1.0), Gemini text and image edits (`./gemini`),
Claude text (`./claude`), OpenAI text and image edits (`./openai`),
Replicate, fal and Black Forest Labs image edits (`./replicate`,
`./fal`, `./bfl`), Grok text and image edits
(`./grok`), OpenRouter, LM Studio, vLLM and llama.cpp server text
(`./openai-compatible`).

1. **`createProviders(config)`**: build the configured providers from a
   plain object (provider name, host, model, key), so apps don't each
   write the same switch. Keys are passed in, never read from the
   environment.
2. **Model listing**: `listModels()` for Ollama (`GET /api/tags`), for a
   settings page's dropdown.
3. **Stability AI** (`./stability`): `StabilityImageGenerator`, Stable
   Image edits over `fetch`.
4. **Stable Diffusion local API** (`./sdwebui`): `SdWebUiImageGenerator`
   for the AUTOMATIC1111 / Forge web UI's `/sdapi/v1/img2img`, with the
   same host check as ComfyUI.

Each new provider follows "Adding a provider" in `CLAUDE.md`: its own
subpath, tests against a fake `fetch`, and a changeset.

ChatGPT: the GPT models behind ChatGPT are already available through
`./openai` with an API key. A ChatGPT plan itself has no public API, so it
can't be a provider; API use is billed separately from the plan.

Not planned: streaming, chat history, or tool use. This package covers
one-shot "turn this into text or an image" tasks.
