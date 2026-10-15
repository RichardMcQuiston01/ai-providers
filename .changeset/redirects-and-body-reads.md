---
'@richardmcquiston01/ai-providers': patch
---

Provider HTTP calls no longer follow redirects (a redirect now returns an error naming the target); Replicate's output download follows one only to another `replicate.delivery` URL. Reply bodies are read through a size-capped stream, and a failed or truncated read returns an error instead of throwing. `callProvider` returns an error for an unusable `timeoutMs` or URL instead of throwing, and `readHistory` no longer throws on unexpected ComfyUI history entries. Replicate's run time limit now includes the create request.
