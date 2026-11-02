---
"@swissspidy/graft-core": minor
"@swissspidy/graft-a2ui": minor
---

Diagnostics point at the spec. A build's diagnostics about where it disagrees with its spec (mount slot, a scope the spec does not request, a criterion without a check, a trigger the spec declares or does not, a trigger's schedule, event or permissions) carry `spec: { path, line }`, the frontmatter key and the spec line to fix. `Spec.lines` maps each frontmatter key to its line, and `specKey()` and `specCriterion()` look up locations. Frontmatter diagnostics now name the line of the key rather than of its value (a field missing from `mount` is on the `mount:` line), and `title-missing` and `description-missing` carry lines. `build-spec-mismatch` for the spec id and the spec hash is reported separately, at `/spec/id` and `/spec/hash`.
