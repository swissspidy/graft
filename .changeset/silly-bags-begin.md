---
"@swissspidy/graft-core": minor
"@swissspidy/graft-a2ui": minor
---

A Board component for hosts that can draw one (`BOARD_COMPONENT`, `BOARD_GUIDE`): a list's items as cards in columns by the value of one field, with moves between columns bound to events like row actions. The verifier reads each column as a table of its cards, with the moves out of it as row actions. Checks can also call an action the viewer is not offered (a step with `"direct": true`) and expect the host to refuse it (`{"refused": "<action id>"}`).
