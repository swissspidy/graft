---
"@swissspidy/graft-core": minor
"@swissspidy/graft-a2ui": minor
---

Verification records name the build they verified. `verifyBuild()` now sets `build` on the `Verification` to the build's content hash (`buildHash()`, now also exported from its own module), and the new `verificationProblem(verification, build)` says why a record does not show that this exact build passed: it names another build (the build changed after it was verified, even in a way that keeps it valid), none at all (a record from before this change), another spec version or surface, or does not have one passing result for each check. `graft check`, the browser extension's bundle install and serving, and the EmDash store use it, so a build edited after verification no longer counts as verified there. Records without `build` count as unverified: bundle and verify again.
