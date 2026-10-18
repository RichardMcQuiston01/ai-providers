---
'@richardmcquiston01/ai-providers': patch
---

Share more of the HTTP policy the providers used to copy. `downloadImage` (GET, capped read, PNG/JPEG/WebP check) now serves ComfyUI, Replicate, fal and Black Forest Labs; `pollClock` and `pollPause` give the three polling providers one sleep, clock and cancel/deadline check; `readJson` takes a `maxBytes` cap so the Stability AI and Stable Diffusion web UI replies share it. No change in behavior.
