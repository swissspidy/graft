# ADR 0016: Experiments: a customization for a share of its audience

- Status: Accepted (WordPress)
- Date: 2026-11-15
- Builds on: [ADR 0010](0010-scheduled-actions.md), [ADR 0013](0013-operating-and-recovering.md), [ADR 0015](0015-website-host.md)

## Context

A customization is either on for its audience or off. Its checks say it
does what its spec says; nothing says whether it helps. An administrator
who wonders whether a review queue gets posts published faster can only
turn it on for everyone and guess.

The lab (ADR 0015) answers that question for websites: a change goes to a
share of visitors, a metric is counted per bucket, and a rule keeps or
reverts it. The questions were what the bucket, the metric and the rule
are for a customization inside a host, where there are signed-in people
instead of anonymous visitors and no beacons.

## Decisions

### A share of the audience, by user id

An administrator starts an experiment on a live customization with a share
(above 0, at most 0.5). Each person in the audience is bucketed by
`sha256("<spec>:<user id>")`: the first four bytes as a fraction of 2^32,
below the share is the variant. It is the lab's bucketing function, with
the user id as the visitor id, so a person keeps their bucket for the whole
experiment.

The variant sees the customization. The baseline sees the host as it is,
with no customization. The capability gateway refuses the baseline's calls
as it refuses anyone the customization is not served to, so the split is
enforced, not just drawn.

Only customizations for the whole site can be tested. A team's or a
person's has too few people to compare. A customization with triggers
cannot be tested either: its triggers run as the service identity for
everyone, so the baseline would not be a baseline.

### The metric is a host event

The metric is one of the surface's trigger events (ADR 0010): for
WordPress, `post.published` or `post.submitted`. The host already turns a
post's status change into these events, and knows who caused it. A
person counts as seen on each day they are served, or not served because
they are in the baseline. They count as converted on a day they cause the
metric event. Events that triggers cause have no person behind them and
are not counted.

Counting person-days rather than page views keeps one busy editor from
outweighing everyone else, and gives the binary outcome per unit the
decision rule needs.

### The lab's decision rule

The rule is the lab's, ported to PHP so that it runs on the site:

- P(variant better) from Beta(1, 1) priors and a normal approximation of
  the two posteriors.
- Keep when P ≥ 0.95 and both buckets have the planned sample
  (`minPerBucket` person-days, default 100).
- Revert when P ≤ 0.05 with the planned sample, or when `maxDays`
  (default 14) pass without a keep.

A daily job applies the rule, and `POST graft/v1/experiments/decide`
applies it on demand. Each running experiment is its own option. A start
is one insert that fails while the option is taken. An end first swaps the
exact experiment it was decided on for an "ending" marker, in one update,
so a stale decision can never end a later experiment, and nothing can start
until the end has archived (or kept) and removed the marker, or put the
experiment back. A marker left by a request that died is cleared by the
next start after ten minutes; an end renews its marker in one update right
before it archives, so an end that stalled past that and lost its marker
changes nothing. Once the marker is in place recorders find no
running experiment, and the daily rule is applied again on the counts as
they stand: if it no longer holds, the experiment is put back and keeps
running. A request that was already recording at that instant may still
add its row; it is not in the decision, and it goes with the experiment's
other rows. `maxDays` counts elapsed time from
the start. Events are counted only while the customization can be served
at all: in safe mode, or without a build for the current surface, neither
bucket is seeing what is being tested. Keeping removes the experiment, so the customization
is served to its whole audience. Reverting archives the version that was
tested.

If the tested version stops being live for another reason (a new version
supersedes it, the host changes and it upgrades, someone archives it), the
experiment ends without a decision. Its counts would otherwise mix two
customizations.

Every start and end goes into the change log (ADR 0013) with the counts:
`experiment_started`, `experiment_kept`, `experiment_reverted` and
`experiment_abandoned`.

### Operational, not part of the spec

An experiment is a decision about rolling a customization out, not part
of what the customization is. The spec, its criteria and its checks stay
the same, and the build is the same in both buckets. So an experiment
lives in the site's state, not in the spec's frontmatter, and Graft's
schema and core are unchanged.

## Alternatives considered

- **Experiment settings in the spec.** It would put a rollout decision into
  the contract and change the closed schema for every host. An author
  could also not test a customization someone else wrote.
- **Two customizations, A against B.** More general, but most questions
  are "does this help at all", and comparing against the host as it is
  answers them without a second build to write and verify.
- **Beacons from the customization's UI.** Only the variant has the UI, so
  the baseline could never convert. Host events count both buckets the
  same way.
- **Running the rule in the lab.** The lab would need credentials to the
  site and to be running. On the site, the experiment ends on time even if
  nothing outside watches it.

## Implementation

- `hosts/wordpress/plugin/includes/experiments.php`: bucketing, counting,
  the rule, the daily job and the REST API (`GET graft/v1/experiments`,
  `POST` and `DELETE graft/v1/specs/<id>/experiment`,
  `POST graft/v1/experiments/decide`), administrators only.
- `servable_specs()` serves an experiment's customization to the variant
  only.
- `GET graft/v1/specs` carries each spec's running experiment for
  administrators (`experiment_view()`: the decision now and the viewer's
  bucket); the screen's options come from `experiment_options()`.
- `hosts/wordpress/adapter/src/client/experiment.tsx`: the screen's part.
- `post_transition_event()` is shared by triggers and experiments.
- `hosts/wordpress/playground/smoke.php` checks the bucketing against the
  lab's, the refusals, that each bucket sees what it should, the counts,
  keep, revert, the change log, and the end of an experiment whose version
  stops being live.

## Consequences

- An administrator can ask whether a customization helps, and the site
  answers within the experiment's days.
- Tools → Customizations shows a running experiment on the live version:
  the share, the metric, the counts per group, the rule's verdict now, and
  buttons to keep it for everyone or revert it. A live customization for
  the whole site with no triggers offers "Test it" with a share and a
  metric. An administrator in the baseline sees "Not showing to you" with
  the reason (ADR 0013), since the version itself is served.
- Counts are post meta on the spec: one row per person, day, bucket and
  kind, only ever added, and keyed by the experiment's id. Concurrent
  requests cannot lose each other's counts, a request cannot bring back an
  experiment that ended, and the rows go when it ends. That is fine for a
  site's editors; many thousands of signed-in people would need a table.
- EmDash and the browser extension have no experiments. Their hosts would
  need the same event attribution first.
