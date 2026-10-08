# @graft/a2ui-wp

An [A2UI](https://a2ui.org/) v0.9 client: the framework-agnostic protocol
core (`./core`: messages, data model, bindings, expressions, functions) and a
React renderer with the basic catalog on `@wordpress/components` (`./react`).

Copied from [swissspidy/a2ui-wp](https://github.com/swissspidy/a2ui-wp) at
`aa20b78` (`src/core`, `src/react`, `src/types`, `src/index.ts`, and the
protocol tests from `tests/js`), unchanged apart from test import paths.
Changes should go upstream first; this copy is temporary while Graft
evaluates A2UI as its UI format, until a2ui-wp is published as a package.

## License

At the time of copying, a2ui-wp is GPL-2.0-or-later, which is what this
package declares. Its author is relicensing it under a dual license so it
can be used in Graft (Apache-2.0); until that lands upstream, this package
must not be merged into Graft's main branch.
