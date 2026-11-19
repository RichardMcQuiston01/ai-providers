---
'@richardmcquiston01/ai-providers': patch
---

Clients built on the `openai` package (OpenAI, Grok text, OpenRouter, LM Studio, vLLM, llama.cpp and other OpenAI-compatible servers) no longer follow redirects, which would have carried prompts and images to an origin the host check never saw; a redirect is now an error naming the origin it pointed to. They also send their own `Authorization` header, so `OPENAI_CUSTOM_HEADERS` in the environment can no longer replace the key passed in.
