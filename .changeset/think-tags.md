---
'@richardmcquiston01/ai-providers': patch
---

`stripThinking` now removes nested `<think>` blocks completely and drops a block that is never closed (a truncated reply) from its tag to the end, so reasoning no longer leaks into the text.
