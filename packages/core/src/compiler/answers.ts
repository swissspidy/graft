import { requireUiFormat } from '../build/format.ts';
import type { Build, Check } from '../build/types.ts';

/**
 * A build expressed as the compiler's model output (checks, and the UI in
 * its format), for scripted models in tests.
 * `dataInput` replaces data source inputs by name.
 */
export function modelAnswers(build: Build, dataInput?: Record<string, unknown>) {
	return {
		checks: {
			unverifiable: [],
			checks: build.checks.map((c: Check) => ({
				criterion: c.criterion,
				fixtures_json: JSON.stringify(c.fixtures ?? {}),
				view_as: c.view_as ?? '',
				advance_days: c.clock?.advanceDays ?? 0,
				steps_json: JSON.stringify(c.steps ?? []),
				expect_json: JSON.stringify(c.expect),
			})),
		},
		ui: formatAnswer(build, dataInput),
	};
}

function formatAnswer(build: Build, dataInput?: Record<string, unknown>): unknown {
	const format = requireUiFormat(build);
	if (!format.compiler?.answer) {
		throw new Error(`The ${format.name} format cannot express a build as model output.`);
	}
	return format.compiler.answer(build, dataInput);
}
