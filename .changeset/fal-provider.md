---
'@richardmcquiston01/ai-providers': minor
---

Add `FalImageGenerator` (image edits with any fal model, over plain `fetch`) on the `./fal` subpath and the main entry. It submits to fal's queue, polls, reads the result and downloads the image; a request that is aborted or runs too long is cancelled on fal. The API key is only sent to `queue.fal.run`, and output is only downloaded from `fal.media` and `fal.run` (plus any `outputHosts` you list).
