---
'@richardmcquiston01/ai-providers': patch
---

`GeminiTextGenerator` and `GeminiImageGenerator` keep the API key in a runtime-private field (`#apiKey`), so it no longer appears in `JSON.stringify`, object spreads, `Object.keys` or `util.inspect` / `console.log` output of a generator.
