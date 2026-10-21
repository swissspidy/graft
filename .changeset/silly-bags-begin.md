---
"@swissspidy/graft-core": minor
"@swissspidy/graft-a2ui": minor
---

Dragging in the Graft catalog: a Card with `draggable` can be dropped on a Column, Row or Card with a `dropTarget`, which presses the Card's Button with that `dropTarget`. The verifier reads a template of Cards as a list of rows and records which drop target each list is in. Checks can drag (`{"drop": {...}, "on": "<target>"}`), read the rows in one place (`{"rows": [...], "in": "<target>"}`), call an action the viewer is not offered (`"direct": true`), and expect the host to refuse it (`{"refused": "<action id>"}`).
