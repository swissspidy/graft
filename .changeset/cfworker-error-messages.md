---
'@swissspidy/graft-core': minor
---

The cfworker schema engine (`@swissspidy/graft-core/cfworker`) now words `required` and `pattern` errors as Ajv does, with the missing property's name and the pattern in `message` (`must have required property 'due'`, `must match pattern "^[a-z]+$"`). Hosts that show `error.message` directly read the same on either engine.
