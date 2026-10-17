---
'@richardmcquiston01/ai-providers': minor
---

Add `createProviders`, `createTextGenerator` and `createImageGenerator` on the new `./providers` subpath. They build generators from plain settings (`{ provider: 'ollama', model: 'llama3.2' }`), so apps don't each write the same switch over providers. `TEXT_PROVIDERS` and `IMAGE_PROVIDERS` list the accepted names for a settings dropdown, and an unknown name is an error that lists the valid ones. Keys are passed in; the package still never reads the environment. The subpath is kept out of the main entry because it imports every provider.
