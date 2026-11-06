---
'@richardmcquiston01/ai-providers':
  patch
---

`OllamaTextGenerator` now checks images like the other text providers: PNG, JPEG or WebP and not empty, with a specific error naming the image, before anything is sent. The README gains a "Describe an image" example and a Vision column in the providers table.
