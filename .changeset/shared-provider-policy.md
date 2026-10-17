---
'@richardmcquiston01/ai-providers': patch
---

Share the policy that each provider used to copy: `isAborted`, `loadOptionalPackage` and `describeSdkError` (in `http`) and `checkImageInput` (in `images`) are now exported and used by every provider. Input-image errors now read the same everywhere ("Image 1 is image/gif; fal takes PNG, JPEG or WebP."), and the Claude provider also strips the status prefix the SDK puts on its messages.
