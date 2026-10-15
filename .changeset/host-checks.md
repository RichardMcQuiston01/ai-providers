---
'@richardmcquiston01/ai-providers': minor
---

`OllamaTextGenerator` and `ComfyUiImageGenerator` now run `checkProviderHost` on their `host` (new `allowedHosts` and `allowedHostsLabel` options). A host that is not this machine and not allow-listed, is not an origin, or carries a username or password makes the call return an error instead of being used; an empty host falls back to the default. `checkProviderHost` no longer repeats the URL in its messages, refuses URLs with credentials, and matches IPv6 allow-list entries, trailing-dot names and IPv4-mapped loopback addresses.
