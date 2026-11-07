---
'@richardmcquiston01/ai-providers': patch
---

`checkImageInput` now checks an input image's bytes as well as its declared type. Before, a file labelled `image/png` was accepted whatever it contained, so mislabelled files and non-images (an SVG, text, a truncated download) were sent to the provider under the wrong type. Now the first bytes must match the label (PNG, JPEG or WebP; GIF where a provider allows it), and the error says what the bytes look like. Callers with real images are unaffected; callers that guessed the type from a file extension may now see an error naming the correct label.
