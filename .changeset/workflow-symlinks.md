---
'@richardmcquiston01/ai-providers': patch
---

`directoryWorkflowSource` no longer follows symbolic links out of the workflows folder: it lists only regular `.json` files, reads a file only if its real path is inside the real folder (opened with `O_NOFOLLOW` where available), and applies one name rule to both `list` and `read` (no separators, `..`, `:` or NUL). A linked workflow file must be copied into the folder instead.
