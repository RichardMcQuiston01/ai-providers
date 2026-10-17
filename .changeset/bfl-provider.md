---
'@richardmcquiston01/ai-providers': minor
---

Add `BflImageGenerator` (FLUX Kontext image edits from Black Forest Labs, over plain `fetch`) on the `./bfl` subpath and the main entry. It submits a task, polls its URL until Ready and downloads the image. The API key is only sent to `bfl.ai`, output is only downloaded from `bfl.ai` subdomains (plus any `outputHosts` you list), and moderation and task errors come back as specific messages. BFL has no cancel call, so a task you stop waiting for may still run.
