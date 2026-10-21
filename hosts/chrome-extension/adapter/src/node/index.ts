export * from '../host/index.ts';
export { tasklet, taskletProbes } from '../apps/tasklet.ts';
export { connectSandbox, startTaskletSandbox, verifyInBrowserHost, type FixtureSandbox, type TaskletSandbox, type VerifyTarget } from './sandbox.ts';
export {
	checkDrift,
	formatDriftReport,
	observe,
	observedSurface,
	observedVersion,
	shapeOf,
	undeclaredKeys,
	type BuildDrift,
	type CapabilityObservation,
	type DriftReport,
	type Observation,
	type ObserveOptions,
	type Probes,
	type SlotObservation,
} from './drift.ts';
export { startTasklet, type TaskletServer, type TaskletVersion } from '../../../fixtures/tasklet/server.ts';
export { upgradeAfterDrift } from './upgrade.ts';
export type { Build, Surface } from '@swissspidy/graft-core';
