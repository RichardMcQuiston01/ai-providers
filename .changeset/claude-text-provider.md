---
'@richardmcquiston01/ai-providers': minor
---

New `./claude` subpath: `ClaudeTextGenerator`, text from Anthropic's Claude API through the official `@anthropic-ai/sdk` (an optional peer dependency, loaded on first use). Defaults to `claude-opus-5-5`, takes an optional `effort`, opts into the server-side refusal fallback on models that support it (`refusalFallback: false` to turn it off), accepts images, and returns API errors and refusals as specific Result errors. The key is passed in, kept in a private field, and the SDK is not allowed to read credentials from the environment.
