# CHANGELOG

## 0.4.0

### Minor Changes

- e18de52: Add Grok (xAI) providers on the `./grok` subpath: `GrokTextGenerator` (through the optional `openai` peer, pointed at api.x.ai) and `GrokImageGenerator` (image edits over `fetch`). `./openai` now also exports `ChatCompletionsTextGenerator` and `ChatEndpoint` for OpenAI-compatible APIs.
- 2ddead0: `OllamaTextGenerator` and `ComfyUiImageGenerator` now run `checkProviderHost` on their `host` (new `allowedHosts` and `allowedHostsLabel` options). A host that is not this machine and not allow-listed, is not an origin, or carries a username or password makes the call return an error instead of being used; an empty host falls back to the default. `checkProviderHost` no longer repeats the URL in its messages, refuses URLs with credentials, and matches IPv6 allow-list entries, trailing-dot names and IPv4-mapped loopback addresses.
- 96101a4: Add OpenAI providers on the `./openai` subpath: `OpenAiTextGenerator` (Chat Completions, with optional images) and `OpenAiImageGenerator` (GPT Image edits). The `openai` package is an optional peer dependency.
- 892a0d8: Add `ReplicateImageGenerator` (image edits with any Replicate image model, over plain `fetch`) on the `./replicate` subpath and the main entry. Error messages now include the `detail` field of Replicate-style error bodies.

### Patch Changes

- f87bff5: `ComfyUiImageGenerator` now puts `request.instructions` ahead of the prompt in `{{PROMPT}}` (as the other image providers do; blank instructions change nothing). When the caller aborts or the run time limit passes, it removes the prompt from ComfyUI's queue or interrupts it if it is the one running, and an abort no longer waits out the poll interval. New exported helper `promptWithInstructions`.
- da4dca2: Image providers (Gemini, OpenAI, Grok, ComfyUI, Replicate) now return only PNG, JPEG or WebP, and `AiImage.mimeType` is decided from the returned bytes instead of a declared type (`output_format`, `Content-Type`, file extension). Other data, including SVG, is an error. Grok's WebP check now requires the full `RIFF`/`WEBP` marks. New exports: `IMAGE_TYPES`, `sniffImageType`, `checkImageOutput`; the input allow list is shared.
- e708329: Provider HTTP calls no longer follow redirects (a redirect now returns an error naming the target); Replicate's output download follows one only to another `replicate.delivery` URL. Reply bodies are read through a size-capped stream, and a failed or truncated read returns an error instead of throwing. `callProvider` returns an error for an unusable `timeoutMs` or URL instead of throwing, and `readHistory` no longer throws on unexpected ComfyUI history entries. Replicate's run time limit now includes the create request.
- c401b0c: `stripThinking` now removes nested `<think>` blocks completely and drops a block that is never closed (a truncated reply) from its tag to the end, so reasoning no longer leaks into the text.
- 998b693: `directoryWorkflowSource` no longer follows symbolic links out of the workflows folder: it lists only regular `.json` files, reads a file only if its real path is inside the real folder (opened with `O_NOFOLLOW` where available), and applies one name rule to both `list` and `read` (no separators, `..`, `:` or NUL). A linked workflow file must be copied into the folder instead.

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
