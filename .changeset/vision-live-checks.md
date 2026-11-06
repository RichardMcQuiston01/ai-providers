---
'@richardmcquiston01/ai-providers': patch
---

The live check gains vision checks (`ollama-vision`, `lmstudio-vision`, `vllm-vision`, `llamacpp-vision`, `claude-vision`, `openai-vision`, `grok-vision`, `openrouter-vision`) that send the test image and print the model's description. Ollama's has its own `OLLAMA_VISION_MODEL`; the others use the provider's existing settings.
