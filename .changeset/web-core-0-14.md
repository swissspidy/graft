---
"@swissspidy/graft-a2ui": minor
"@swissspidy/graft-core": minor
---

graft-a2ui moves to `@a2ui/web_core` 0.14, the version `@swissspidy/a2ui-wp` 0.2 renders with; apps that pass graft-a2ui catalogs to a renderer need the same web_core. web_core 0.14 refuses to run regex patterns that can backtrack catastrophically (ReDoS), so validation now reports them as `a2ui-unsafe-pattern` instead of a build that silently stops working, and the compiler guide tells models to anchor patterns.
