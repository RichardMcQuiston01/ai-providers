---
'@richardmcquiston01/ai-providers': minor
---

Add `./openai-compatible` with text generators for OpenRouter (`OpenRouterTextGenerator`, hosted, with optional attribution headers) and local OpenAI-protocol servers (`LmStudioTextGenerator`, `VllmTextGenerator`, `LlamaCppTextGenerator`, and `OpenAiCompatibleTextGenerator` for any other). Local hosts are checked with `checkProviderHost` (this machine unless in `allowedHosts`), need no key, and the `openai` peer is never allowed to read OpenAI environment settings. `ChatEndpoint` gains `keyOptional`, `headers` and `setupError`.
