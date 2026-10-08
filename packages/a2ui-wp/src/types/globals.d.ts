/**
 * React reads this flag to decide whether to warn about updates outside
 * `act()`; the test setup turns it on for the duration of a run.
 */
// eslint-disable-next-line no-var
declare var IS_REACT_ACT_ENVIRONMENT: unknown;
