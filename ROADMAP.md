# Roadmap

Done: Ollama and ComfyUI (0.1.0), Gemini text and image edits (`./gemini`),
Claude text (`./claude`), OpenAI text and image edits (`./openai`),
Replicate, fal, Black Forest Labs and Stability AI image edits
(`./replicate`, `./fal`, `./bfl`, `./stability`), the Stable Diffusion
local API (`./sdwebui`), `createProviders` (`./providers`), Grok text and image edits
(`./grok`), OpenRouter, LM Studio, vLLM and llama.cpp server text
(`./openai-compatible`).

1. **Model listing**: `listModels()` for Ollama (`GET /api/tags`), for a
   settings page's dropdown.

Each new provider follows "Adding a provider" in `CLAUDE.md`: its own
subpath, tests against a fake `fetch`, and a changeset.

ChatGPT: the GPT models behind ChatGPT are already available through
`./openai` with an API key. A ChatGPT plan itself has no public API, so it
can't be a provider; API use is billed separately from the plan.

Not planned: streaming, chat history, or tool use. This package covers
one-shot "turn this into text or an image" tasks.
