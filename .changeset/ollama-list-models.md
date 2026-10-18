---
'@richardmcquiston01/ai-providers': minor
---

Add `listOllamaModels` (and `OllamaTextGenerator.listModels()`): the models an Ollama host has pulled (`GET /api/tags`), sorted, for a settings dropdown. It needs no model, so it works before one is chosen, and the host goes through the same `checkProviderHost` check as the generator.
