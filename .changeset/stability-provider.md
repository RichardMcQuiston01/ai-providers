---
'@richardmcquiston01/ai-providers': minor
---

Add `StabilityImageGenerator` (Stable Image edits from Stability AI, over plain `fetch`) on the `./stability` subpath and the main entry. Modes are `image-to-image` (the default, on Stable Diffusion 3.5), `structure`, `search-and-replace`, `search-and-recolor` and `remove-background`. Calls are one request and one reply, so there is no job to cancel; filtered results (`CONTENT_FILTERED`) and Stability's error messages come back as specific errors. The API key is only sent to `api.stability.ai`. `providerMessage` now also reads an `errors` list from error bodies.
