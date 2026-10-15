# Roadmap

Done: Ollama and ComfyUI (0.1.0), Gemini text and image edits (`./gemini`),
Claude text (`./claude`), OpenAI text and image edits (`./openai`),
Replicate image edits (`./replicate`), Grok text and image edits
(`./grok`).

1. **`createProviders(config)`**: build the configured providers from a
   plain object (provider name, host, model, key), so apps don't each
   write the same switch. Keys are passed in, never read from the
   environment.
2. **Model listing**: `listModels()` for Ollama (`GET /api/tags`), for a
   settings page's dropdown.
3. **OpenAI-compatible text**: reuse `ChatCompletionsTextGenerator`
   (see `./openai`) with a `baseUrl`, so no new peer package.
   - **OpenRouter** (hosted): one key for many models, text and vision.
     Its own provider, since it needs an API key and sends extra headers.
   - **LM Studio**, **vLLM** and **llama.cpp server** (local): the
     host is checked with `checkProviderHost` like Ollama's, and a key is
     optional. They may share one `./openai-compatible` provider rather
     than three.
4. **fal.ai** (`./fal`): `FalImageGenerator`, hosted FLUX and other image
   models. Queue, poll and download like Replicate, over plain `fetch`.
5. **Black Forest Labs** (`./bfl`): `BflImageGenerator`, FLUX Kontext
   edits straight from the maker. Submit, poll, download, over `fetch`.
6. **Stability AI** (`./stability`): `StabilityImageGenerator`, Stable
   Image edits over `fetch`.
7. **Stable Diffusion local API** (`./sdwebui`): `SdWebUiImageGenerator`
   for the AUTOMATIC1111 / Forge web UI's `/sdapi/v1/img2img`, with the
   same host check as ComfyUI.

Each new provider follows "Adding a provider" in `CLAUDE.md`: its own
subpath, tests against a fake `fetch`, and a changeset.

ChatGPT: the GPT models behind ChatGPT are already available through
`./openai` with an API key. A ChatGPT plan itself has no public API, so it
can't be a provider; API use is billed separately from the plan.

Not planned: streaming, chat history, or tool use. This package covers
one-shot "turn this into text or an image" tasks.
