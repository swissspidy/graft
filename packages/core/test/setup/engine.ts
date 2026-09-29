import { setSchemaEngine } from '../../src/index.ts';
import { cfworkerEngine } from '../../src/schema-cfworker.ts';

// GRAFT_SCHEMA_ENGINE=cfworker runs the whole suite on the engine used where
// code generation is forbidden (the EmDash sandbox).
if (process.env.GRAFT_SCHEMA_ENGINE === 'cfworker') {
	setSchemaEngine(cfworkerEngine());
}
