---
'@richardmcquiston01/ai-providers': minor
---

Add Gemini providers in a new `./gemini` subpath: `GeminiTextGenerator` (text) and `GeminiImageGenerator` (photo edits, one mode named after the model). They use `@richardmcquiston01/gemini-icon-gen` 0.3.0+ as an optional peer dependency loaded with `import()`, and return an error naming the package when it isn't installed. The API key is passed in, never read from the environment. Also adds `fromBase64`.
