# Vision (image in, text out): design

Status: draft, for discussion. Nothing here is implemented.

## Finding: the port already exists

`TextRequest` has had an optional `images` field since the start
(`src/port.ts`), and most text providers already send it. So "image
identification" does not need a new port, and adding a separate
`ImageDescriber` interface would only duplicate `TextGenerator`. The work is
closing the gaps below and saying so in the docs.

| Provider                                     | Sends `images` | Input checked (`checkImageInput`) | Notes                                     |
| -------------------------------------------- | :------------: | :-------------------------------: | ----------------------------------------- |
| OpenAI                                       |      yes       |                yes                | Chat Completions image parts              |
| Grok, OpenRouter, LM Studio, vLLM, llama.cpp |      yes       |                yes                | Same `ChatCompletionsTextGenerator`       |
| Claude                                       |      yes       |                yes                | Image blocks before the prompt            |
| Ollama                                       |      yes       |              **no**               | Base64 only; type and emptiness unchecked |
| Gemini                                       |     **no**     |                n/a                | Returns "doesn't take images yet"         |

Whether a given model accepts images depends on the model and server, not
the provider; that is already stated in the README.

## Rules this has to respect

- Providers only generate. "Describe this image", "list the objects" and
  similar are prompts, so they stay with the consumer. No `describeImage()`
  helper here.
- Results, not throws; errors name the provider, model, what was being
  done, the status and the provider's message.
- Runtime-neutral core; no `Buffer`. Images are `Uint8Array` with a MIME
  type, as today.
- Data in only. No image URLs: fetching a caller-supplied URL from inside
  the library is a request-forgery risk and breaks "local by default".

## Proposed changes

1. **Ollama: validate input.** Run each image through `checkImageInput`
   (PNG, JPEG, WebP, not empty) and fail with the same specific message the
   other providers give, before the request. Add tests for the request body
   (`images` as base64, in order) and for the rejected cases.
2. **Gemini: accept images.** `GeminiTextGenerator` goes through
   `@richardmcquiston01/gemini-icon-gen`'s `generateText`, which takes no
   images today. Two options:
   - **A (preferred):** add optional inline images to `generateText` in
     gemini-icon-gen, raise the peer range, and replace the guard in
     `gemini.ts` with `toInline` (already used for image edits).
   - **B:** keep the guard and document Gemini as text-only for now.
3. **Live checks.** Add `*-vision` entries to `scripts/live-check.ts` that
   send the generated (or `--image`) test image with a fixed prompt
   ("Describe this image in one short sentence.") and print the reply.
   Ollama needs its own variable, `OLLAMA_VISION_MODEL`, because the chat
   model is often not a vision model. Hosted entries reuse the existing
   keys and models; each is one call. `--prompt` stays image-edit only.
4. **Docs.** A "Describe an image" example in the README, a "Vision" column
   in the providers table, and the new variable in `CONFIGURATION.md`.

## Decided against (for now)

- **A capability flag** such as `acceptsImages`. It would have to be per
  model, which we can't know without calling the provider, so a flag would
  be wrong often enough to mislead. Provider error messages are the signal.
- **A size or dimension cap.** Limits differ by provider and change.
  Non-empty and a supported type are checked; the provider's own error
  covers the rest and is passed through.
- **Video, PDFs, streaming.** Out of scope, as in `ROADMAP.md`.

## Open questions

- Does etsy-dashboard (or Maker Toolkit) need vision? That decides the
  order against other roadmap work.
- Which vision model is pulled in Ollama? (Needed for the live check.)
- Gemini option A changes gemini-icon-gen, which is also ours. OK to take
  that on, or keep Gemini text-only?

## Plan and releases

| PR  | Change                                    | Changeset               |
| --- | ----------------------------------------- | ----------------------- |
| 1   | Ollama input validation, tests, README    | patch (behaviour fix)   |
| 2   | Vision live checks, `OLLAMA_VISION_MODEL` | patch (script and docs) |
| 3   | Gemini images (needs gemini-icon-gen)     | minor (new capability)  |
