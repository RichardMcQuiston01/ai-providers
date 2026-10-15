---
'@richardmcquiston01/ai-providers': patch
---

Image providers (Gemini, OpenAI, Grok, ComfyUI, Replicate) now return only PNG, JPEG or WebP, and `AiImage.mimeType` is decided from the returned bytes instead of a declared type (`output_format`, `Content-Type`, file extension). Other data, including SVG, is an error. Grok's WebP check now requires the full `RIFF`/`WEBP` marks. New exports: `IMAGE_TYPES`, `sniffImageType`, `checkImageOutput`; the input allow list is shared.
