# CHANGELOG

## 0.3.0

### Minor Changes

- f6d4f1f: New `./claude` subpath: `ClaudeTextGenerator`, text from Anthropic's Claude API through the official `@anthropic-ai/sdk` (an optional peer dependency, loaded on first use). Defaults to `claude-opus-5-5`, takes an optional `effort`, opts into the server-side refusal fallback on models that support it (`refusalFallback: false` to turn it off), accepts images, and returns API errors and refusals as specific Result errors. The key is passed in, kept in a private field, and the SDK is not allowed to read credentials from the environment.

## 0.2.2

### Patch Changes

- 2f978eb: `GeminiTextGenerator` and `GeminiImageGenerator` keep the API key in a runtime-private field (`#apiKey`), so it no longer appears in `JSON.stringify`, object spreads, `Object.keys` or `util.inspect` / `console.log` output of a generator.

## 0.2.1

### Patch Changes

- dacef2e: `GeminiTextGenerator` now defaults to `gemini-3.8-flash`: Google no longer offers `gemini-2.5-flash` to new API keys. Pass `model` to choose another.

## 0.2.0

### Minor Changes

- dfa68c7: Add Gemini providers in a new `./gemini` subpath: `GeminiTextGenerator` (text) and `GeminiImageGenerator` (photo edits, one mode named after the model). They use `@richardmcquiston01/gemini-icon-gen` 0.3.0+ as an optional peer dependency loaded with `import()`, and return an error naming the package when it isn't installed. The API key is passed in, never read from the environment. Also adds `fromBase64`.

## 0.1.0

### Minor Changes

- ed8d2b8: First release, extracted from etsy-dashboard's `src/ai/`: the
  `TextGenerator`/`ImageGenerator` interfaces, `OllamaTextGenerator`,
  `ComfyUiImageGenerator` with workflow parsing and filling,
  `memoryWorkflowSource`, `directoryWorkflowSource` (`./node`),
  `checkProviderHost`/`parseAllowedHosts`, and the shared HTTP helpers.
  Constructors take an options object.
