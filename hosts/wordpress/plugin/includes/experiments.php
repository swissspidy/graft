<?php
/**
 * Experiments (ADR 0016): an active customization shown to a share of its
 * audience, measured by a host event, then kept for everyone in its audience
 * or archived.
 *
 * Bucketing is by user id and sticky. People in the audience but outside
 * the share are the baseline: they see no customization. A person counts
 * once per day they were served (seen), and as converted on a day they
 * caused the metric event. The decision rule is the lab's: keep at the
 * planned sample when P(variant better) >= 0.95, archive when it is <= 0.05
 * or when the experiment runs out of days.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;
use WP_Post;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;
use WP_User;

/** One option per running experiment: `graft_experiment_<spec id>`. */
const EXPERIMENT_OPTION_PREFIX = 'graft_experiment_';
const EXPERIMENT_KEEP    = 0.95;
const EXPERIMENT_REVERT  = 0.05;
const EXPERIMENT_MAX_SHARE = 0.5;
/**
 * Post meta on the spec: one row per person, day, bucket and kind, as
 * "<experiment id>|<day>|<bucket>|<user id>|<seen|converted>". Rows are only
 * ever added (add_post_meta is one INSERT), so concurrent requests cannot
 * lose each other's counts, and rows of an experiment that ended do not
 * count for the next one.
 */
const EXPERIMENT_MARK = '_graft_experiment_mark';

/**
 * The option that holds a spec's running experiment.
 *
 * @param string $spec_id Spec id.
 * @return string
 */
function experiment_option( string $spec_id ): string {
	return EXPERIMENT_OPTION_PREFIX . $spec_id;
}

/**
 * Running experiments, keyed by spec id.
 *
 * @return array<string, array<string, mixed>>
 */
function experiments(): array {
	global $wpdb;
	$names = $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s ORDER BY option_name", $wpdb->esc_like( EXPERIMENT_OPTION_PREFIX ) . '%' ) );
	$all   = array();
	foreach ( $names as $name ) {
		$spec_id    = substr( (string) $name, strlen( EXPERIMENT_OPTION_PREFIX ) );
		$experiment = experiment_of( $spec_id );
		if ( $experiment ) {
			$all[ $spec_id ] = $experiment;
		}
	}
	return $all;
}

/**
 * The running experiment of a spec, or null. An experiment that is ending
 * (see experiment_claim_end()) is not running.
 *
 * @param string $spec_id Spec id.
 * @return array<string, mixed>|null
 */
function experiment_of( string $spec_id ): ?array {
	$value = get_option( experiment_option( $spec_id ), null );
	return is_array( $value ) && ! isset( $value['ending'] ) ? $value : null;
}

/** How long an end may hold its marker before a start may clear it (a request that died). */
const EXPERIMENT_ENDING_TIMEOUT = 600;

/**
 * Stores an experiment only if none runs or is ending for the spec:
 * add_option is one INSERT on the option's unique name, so two starts
 * cannot both succeed. A marker left by an end that died long ago is
 * cleared first.
 *
 * @param string               $spec_id    Spec id.
 * @param array<string, mixed> $experiment Experiment.
 * @return bool Whether it was stored.
 */
function experiment_claim_start( string $spec_id, array $experiment ): bool {
	if ( add_option( experiment_option( $spec_id ), $experiment, '', false ) ) {
		return true;
	}
	wp_cache_delete( experiment_option( $spec_id ), 'options' );
	$current = get_option( experiment_option( $spec_id ), null );
	if ( is_array( $current ) && isset( $current['ending'] ) && time() - (int) ( $current['since'] ?? 0 ) > EXPERIMENT_ENDING_TIMEOUT ) {
		experiment_swap( $spec_id, $current, null );
		return add_option( experiment_option( $spec_id ), $experiment, '', false );
	}
	return false;
}

/**
 * Replaces a spec's option value with another, or removes it, only if it
 * still holds `$from`: one UPDATE or DELETE that matches the stored value.
 *
 * @param string                    $spec_id Spec id.
 * @param array<string, mixed>      $from    The value as it was read.
 * @param array<string, mixed>|null $to      The new value, or null to remove the option.
 * @return bool Whether this call changed it.
 */
function experiment_swap( string $spec_id, array $from, ?array $to ): bool {
	global $wpdb;
	$name    = experiment_option( $spec_id );
	$changed = null === $to
		? $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value = %s", $name, maybe_serialize( $from ) ) )
		: $wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s", maybe_serialize( $to ), $name, maybe_serialize( $from ) ) );
	wp_cache_delete( $name, 'options' );
	wp_cache_delete( 'notoptions', 'options' );
	return 1 === (int) $changed;
}

/**
 * Claims the end of exactly this experiment: swaps it for an "ending"
 * marker in one statement. A request holding a stale copy (an experiment
 * that ended, or one that another took over) changes nothing. The marker
 * keeps the option taken, so no experiment can start until this end
 * finishes (experiment_finish_end()) or puts the experiment back
 * (experiment_restore()).
 *
 * @param string               $spec_id    Spec id.
 * @param array<string, mixed> $experiment The experiment as it was read.
 * @return array<string, mixed>|null The marker, or null when this call did not claim it.
 */
function experiment_claim_end( string $spec_id, array $experiment ): ?array {
	$marker = array(
		'ending'     => (string) ( $experiment['id'] ?? '' ),
		'since'      => time(),
		'experiment' => $experiment,
	);
	return experiment_swap( $spec_id, $experiment, $marker ) ? $marker : null;
}

/**
 * Renews an end's marker, only if it is still this end's: one UPDATE that
 * matches the marker as claimed. A start may clear a marker older than
 * EXPERIMENT_ENDING_TIMEOUT, so an end renews it right before it acts.
 *
 * @param string               $spec_id Spec id.
 * @param array<string, mixed> $marker  The marker as claimed or last renewed.
 * @return array<string, mixed>|null The renewed marker, or null when another request took it over.
 */
function experiment_renew_end( string $spec_id, array $marker ): ?array {
	$renewed = array_merge( $marker, array( 'since' => time() ) );
	if ( $renewed === $marker ) {
		// Same second: nothing to write, but still confirm the marker is ours.
		wp_cache_delete( experiment_option( $spec_id ), 'options' );
		return get_option( experiment_option( $spec_id ), null ) === $marker ? $marker : null;
	}
	return experiment_swap( $spec_id, $marker, $renewed ) ? $renewed : null;
}

/**
 * Removes the marker of an end that completed.
 *
 * @param string               $spec_id Spec id.
 * @param array<string, mixed> $marker  The marker experiment_claim_end() returned.
 */
function experiment_finish_end( string $spec_id, array $marker ): void {
	experiment_swap( $spec_id, $marker, null );
}

/**
 * Puts an experiment back after an end that did not complete.
 *
 * @param string               $spec_id Spec id.
 * @param array<string, mixed> $marker  The marker experiment_claim_end() returned.
 */
function experiment_restore( string $spec_id, array $marker ): void {
	experiment_swap( $spec_id, $marker, $marker['experiment'] );
}

/**
 * Sticky bucketing: the first four bytes of sha256("<spec>:<user>") as a
 * fraction of 2^32, below the share is the variant. The same function as
 * the lab's assignBucket, with the user id as the visitor.
 *
 * @param string $spec_id Spec id.
 * @param int    $user_id User id.
 * @param float  $share   Variant share.
 * @return string 'variant' or 'baseline'.
 */
function experiment_bucket( string $spec_id, int $user_id, float $share ): string {
	$word = unpack( 'N', substr( hash( 'sha256', $spec_id . ':' . $user_id, true ), 0, 4 ) )[1];
	return $word / 4294967296 < $share ? 'variant' : 'baseline';
}

/**
 * Today in UTC, the unit a person is counted in.
 *
 * @return string Y-m-d.
 */
function experiment_day(): string {
	/**
	 * Filters the day an experiment counts in (tests move the clock).
	 *
	 * @param string $day Today, Y-m-d in UTC.
	 */
	return (string) apply_filters( 'graft_experiment_day', gmdate( 'Y-m-d' ) );
}

/**
 * Records a person as seen (and optionally converted) today, in their
 * bucket, for the experiment running now. Only appends rows; never writes
 * the experiment record, so it cannot restore an experiment that ended.
 *
 * @param string $spec_id   Spec id.
 * @param string $bucket    Bucket.
 * @param int    $user_id   User id.
 * @param bool   $converted Whether they caused the metric event.
 */
function experiment_record( string $spec_id, string $bucket, int $user_id, bool $converted ): void {
	$experiment = experiment_of( $spec_id );
	$spec       = get_spec_post( $spec_id );
	if ( ! $experiment || ! $spec || empty( $experiment['id'] ) ) {
		return;
	}
	$prefix   = implode( '|', array( $experiment['id'], experiment_day(), $bucket, $user_id ) );
	$existing = (array) get_post_meta( $spec->ID, EXPERIMENT_MARK );
	foreach ( $converted ? array( 'seen', 'converted' ) : array( 'seen' ) as $kind ) {
		// A duplicate from two requests at once is harmless: counts read distinct rows.
		if ( ! in_array( "$prefix|$kind", $existing, true ) ) {
			add_post_meta( $spec->ID, EXPERIMENT_MARK, "$prefix|$kind" );
		}
	}
}

/**
 * Removes an experiment's rows once it has ended.
 *
 * @param string               $spec_id    Spec id.
 * @param array<string, mixed> $experiment The experiment that ended.
 */
function experiment_forget( string $spec_id, array $experiment ): void {
	$spec = get_spec_post( $spec_id );
	if ( ! $spec || empty( $experiment['id'] ) ) {
		return;
	}
	foreach ( array_unique( (array) get_post_meta( $spec->ID, EXPERIMENT_MARK ) ) as $mark ) {
		if ( 0 === strpos( (string) $mark, $experiment['id'] . '|' ) ) {
			delete_post_meta( $spec->ID, EXPERIMENT_MARK, $mark );
		}
	}
}

/**
 * Whether a spec is served to a user under its experiment, recording that
 * they were seen. Call only for people the spec otherwise applies to.
 *
 * @param array<string, mixed> $record Active version record.
 * @param WP_User              $user   User.
 * @return bool True when there is no experiment or the user is in the variant.
 */
function experiment_serves( array $record, WP_User $user ): bool {
	$spec_id    = (string) $record['spec_id'];
	$experiment = experiment_of( $spec_id );
	if ( ! $experiment ) {
		return true;
	}
	$bucket = experiment_bucket( $spec_id, $user->ID, (float) $experiment['share'] );
	experiment_record( $spec_id, $bucket, $user->ID, false );
	return 'variant' === $bucket;
}

/**
 * Counts per bucket: visits are person-days seen, conversions the
 * person-days that also caused the metric event.
 *
 * @param array<string, mixed> $experiment Experiment.
 * @return array{baseline: array{visits: int, conversions: int}, variant: array{visits: int, conversions: int}}
 */
function experiment_counts( array $experiment ): array {
	$counts = array(
		'baseline' => array( 'visits' => 0, 'conversions' => 0 ),
		'variant'  => array( 'visits' => 0, 'conversions' => 0 ),
	);
	$spec = get_spec_post( (string) $experiment['spec'] );
	if ( ! $spec || empty( $experiment['id'] ) ) {
		return $counts;
	}
	$seen      = array();
	$converted = array();
	foreach ( array_unique( (array) get_post_meta( $spec->ID, EXPERIMENT_MARK ) ) as $mark ) {
		$parts = explode( '|', (string) $mark );
		if ( 5 !== count( $parts ) || $parts[0] !== $experiment['id'] || ! isset( $counts[ $parts[2] ] ) ) {
			continue;
		}
		$person = "$parts[2]|$parts[1]|$parts[3]";
		if ( 'seen' === $parts[4] ) {
			$seen[ $person ] = $parts[2];
		} elseif ( 'converted' === $parts[4] ) {
			$converted[ $person ] = true;
		}
	}
	foreach ( $seen as $person => $bucket ) {
		++$counts[ $bucket ]['visits'];
		if ( isset( $converted[ $person ] ) ) {
			++$counts[ $bucket ]['conversions'];
		}
	}
	return $counts;
}

/**
 * Standard normal CDF (Abramowitz and Stegun 7.1.26, error below 1.5e-7).
 *
 * @param float $z Z.
 * @return float
 */
function normal_cdf( float $z ): float {
	$t    = 1 / ( 1 + 0.3275911 * abs( $z ) / M_SQRT2 );
	$poly = $t * ( 0.254829592 + $t * ( -0.284496736 + $t * ( 1.421413741 + $t * ( -1.453152027 + $t * 1.061405429 ) ) ) );
	$erf  = 1 - $poly * exp( -( $z * $z ) / 2 );
	return $z >= 0 ? ( 1 + $erf ) / 2 : ( 1 - $erf ) / 2;
}

/**
 * P(the variant's conversion rate is higher), with Beta(1, 1) priors and a
 * normal approximation of the two posteriors: the lab's probabilityBetter.
 *
 * @param array{visits: int, conversions: int} $baseline Baseline.
 * @param array{visits: int, conversions: int} $variant  Variant.
 * @return float
 */
function probability_better( array $baseline, array $variant ): float {
	$moments = static function ( array $c ): array {
		$a = $c['conversions'] + 1;
		$b = $c['visits'] - $c['conversions'] + 1;
		return array( $a / ( $a + $b ), ( $a * $b ) / ( ( $a + $b ) ** 2 * ( $a + $b + 1 ) ) );
	};
	list( $mb, $vb ) = $moments( $baseline );
	list( $mv, $vv ) = $moments( $variant );
	return normal_cdf( ( $mv - $mb ) / sqrt( $vb + $vv ) );
}

/**
 * The decision for an experiment now: keep, revert or continue, with why.
 *
 * @param array<string, mixed> $experiment Experiment.
 * @return array{action: string, reason: string, probability: float, counts: array<string, mixed>, days: float}
 */
function experiment_decision( array $experiment ): array {
	$counts = experiment_counts( $experiment );
	$p      = probability_better( $counts['baseline'], $counts['variant'] );
	/**
	 * Filters the time experiments are decided at (tests move the clock).
	 *
	 * @param int $now Unix time.
	 */
	$now  = (int) apply_filters( 'graft_experiment_now', time() );
	$days = ( $now - strtotime( (string) $experiment['started'] ) ) / DAY_IN_SECONDS;
	$per       = (int) $experiment['minPerBucket'];
	$enough    = $counts['baseline']['visits'] >= $per && $counts['variant']['visits'] >= $per;
	$shown     = sprintf( 'P(variant better) = %.3f', $p );
	$result    = array(
		'probability' => $p,
		'counts'      => $counts,
		'days'        => $days,
	);
	if ( $p <= EXPERIMENT_REVERT && $enough ) {
		return $result + array(
			'action' => 'revert',
			'reason' => "$shown ≤ " . EXPERIMENT_REVERT . '.',
		);
	}
	if ( $enough && $p >= EXPERIMENT_KEEP ) {
		return $result + array(
			'action' => 'keep',
			'reason' => "$shown ≥ " . EXPERIMENT_KEEP . ' at the planned sample.',
		);
	}
	if ( $days >= (int) $experiment['maxDays'] ) {
		return $result + array(
			'action' => 'revert',
			'reason' => "No clear win after {$experiment['maxDays']} days ($shown).",
		);
	}
	return $result + array(
		'action' => 'continue',
		'reason' => $enough ? "$shown: not decided yet." : sprintf( 'Waiting for %d person-days per bucket (baseline %d, variant %d).', $per, $counts['baseline']['visits'], $counts['variant']['visits'] ),
	);
}

/**
 * Starts an experiment on an active customization.
 *
 * @param string               $spec_id Spec id.
 * @param array<string, mixed> $args    share, metric (an event of the surface), minPerBucket, maxDays.
 * @return array<string, mixed>|WP_Error The experiment.
 */
function start_experiment( string $spec_id, array $args ) {
	$spec = get_spec_post( $spec_id );
	if ( ! $spec ) {
		return new WP_Error( 'graft_not_found', __( 'Spec not found.', 'graft' ), array( 'status' => 404 ) );
	}
	$active = (int) get_post_meta( $spec->ID, '_graft_active_version', true );
	$post   = $active ? get_version_post( $spec_id, $active ) : null;
	$record = $post ? version_record( $post ) : null;
	if ( ! $record || 'active' !== ( $record['state'] ?? '' ) ) {
		return new WP_Error( 'graft_experiment_not_active', __( 'Only a customization that is live can be tested.', 'graft' ), array( 'status' => 409 ) );
	}
	if ( 'org' !== ( $record['scope']['type'] ?? 'org' ) ) {
		return new WP_Error( 'graft_experiment_scope', __( 'Only a customization for the whole site can be tested. One for a team or a person has too few people to compare.', 'graft' ), array( 'status' => 400 ) );
	}
	if ( ! empty( $record['manifest']['triggers'] ) ) {
		return new WP_Error( 'graft_experiment_triggers', __( 'A customization that acts on its own cannot be tested: its triggers would act for everyone, not only the variant.', 'graft' ), array( 'status' => 400 ) );
	}
	if ( experiment_of( $spec_id ) ) {
		return new WP_Error( 'graft_experiment_running', __( 'This customization is already being tested.', 'graft' ), array( 'status' => 409 ) );
	}
	$share = isset( $args['share'] ) ? (float) $args['share'] : 0.5;
	if ( ! ( $share > 0 && $share <= EXPERIMENT_MAX_SHARE ) ) {
		return new WP_Error( 'graft_experiment_share', sprintf( /* translators: %s: largest share */ __( 'The share must be above 0 and at most %s: the variant stays the minority.', 'graft' ), EXPERIMENT_MAX_SHARE ), array( 'status' => 400 ) );
	}
	$metric = (string) ( $args['metric'] ?? '' );
	if ( ! array_key_exists( $metric, trigger_events() ) ) {
		return new WP_Error( 'graft_experiment_metric', sprintf( /* translators: %s: event ids */ __( 'The metric must be a host event: %s.', 'graft' ), implode( ', ', array_keys( trigger_events() ) ) ), array( 'status' => 400 ) );
	}
	$per  = isset( $args['minPerBucket'] ) ? (int) $args['minPerBucket'] : 100;
	$days = isset( $args['maxDays'] ) ? (int) $args['maxDays'] : 14;
	if ( $per < 10 || $days < 1 || $days > 90 ) {
		return new WP_Error( 'graft_experiment_bounds', __( 'minPerBucket must be at least 10, and maxDays from 1 to 90.', 'graft' ), array( 'status' => 400 ) );
	}
	$experiment = array(
		// Identifies this run: its counts, and the decision that may end it.
		'id'           => wp_generate_uuid4(),
		'spec'         => $spec_id,
		'version'      => $active,
		'share'        => $share,
		'metric'       => $metric,
		'minPerBucket' => $per,
		'maxDays'      => $days,
		'started'      => gmdate( 'c' ),
		'startedBy'    => get_current_user_id(),
	);
	if ( ! experiment_claim_start( $spec_id, $experiment ) ) {
		return new WP_Error( 'graft_experiment_running', __( 'This customization is already being tested.', 'graft' ), array( 'status' => 409 ) );
	}
	record_change( 'experiment_started', $spec_id, $active, array( 'share' => $share, 'metric' => $metric ) );
	return $experiment;
}

/**
 * Ends an experiment: `keep` serves the customization to its whole
 * audience, `revert` archives it.
 *
 * Ending first claims the experiment (experiment_claim_end): only the
 * request that removes it goes on, so a stale decision can never end a
 * later experiment. After the claim no more counts arrive for it; with
 * `$recheck`, the decision is taken again on those final counts, and the
 * experiment is put back if it no longer holds.
 *
 * @param string                    $spec_id  Spec id.
 * @param string                    $outcome  keep or revert.
 * @param string                    $reason   Why, for the change log.
 * @param array<string, mixed>|null $snapshot The experiment a decision was made on. Default: the one running now.
 * @param callable|null             $recheck  Takes the experiment, returns a decision (see experiment_decision()).
 * @return array<string, mixed>|WP_Error The final counts and outcome.
 */
function end_experiment( string $spec_id, string $outcome, string $reason, ?array $snapshot = null, ?callable $recheck = null ) {
	if ( 'keep' !== $outcome && 'revert' !== $outcome ) {
		return new WP_Error( 'graft_experiment_outcome', __( 'The outcome must be keep or revert.', 'graft' ), array( 'status' => 400 ) );
	}
	$experiment = $snapshot ?? experiment_of( $spec_id );
	if ( ! $experiment ) {
		return new WP_Error( 'graft_experiment_none', __( 'This customization is not being tested.', 'graft' ), array( 'status' => 404 ) );
	}
	$marker = experiment_claim_end( $spec_id, $experiment );
	if ( ! $marker ) {
		return new WP_Error( 'graft_experiment_changed', __( 'The experiment changed since it was read: it ended, or another one is running now.', 'graft' ), array( 'status' => 409 ) );
	}
	if ( $recheck ) {
		$decision = $recheck( $experiment );
		if ( ( $decision['action'] ?? null ) !== $outcome ) {
			experiment_restore( $spec_id, $marker );
			return new WP_Error( 'graft_experiment_recomputed', __( 'The decision no longer holds on the final counts; the experiment keeps running.', 'graft' ), array( 'status' => 409 ) );
		}
		$reason = (string) $decision['reason'];
	}
	// An end that took longer than EXPERIMENT_ENDING_TIMEOUT may have lost its marker to a
	// start. Renew it in one statement right before acting: if it is gone, act on nothing.
	$marker = experiment_renew_end( $spec_id, $marker );
	if ( ! $marker ) {
		return new WP_Error( 'graft_experiment_taken_over', __( 'This end took too long and another experiment started meanwhile; nothing was changed.', 'graft' ), array( 'status' => 409 ) );
	}
	if ( 'revert' === $outcome ) {
		$archived = apply_event( $spec_id, (int) $experiment['version'], 'archive' );
		// A version that left `active` meanwhile (an upgrade, a newer version) is not archived here.
		if ( is_wp_error( $archived ) && 'graft_invalid_transition' !== $archived->get_error_code() ) {
			experiment_restore( $spec_id, $marker );
			return $archived;
		}
	}
	experiment_finish_end( $spec_id, $marker );
	$summary = array(
		'outcome' => $outcome,
		'reason'  => $reason,
		'counts'  => experiment_counts( $experiment ),
	);
	experiment_forget( $spec_id, $experiment );
	record_change( 'experiment_' . ( 'keep' === $outcome ? 'kept' : 'reverted' ), $spec_id, (int) $experiment['version'], $summary );
	return $summary;
}

/**
 * Counts a host event for every running experiment that measures it, for
 * the person who caused it (hooked to transition_post_status).
 *
 * @param string  $new_status New status.
 * @param string  $old_status Old status.
 * @param WP_Post $post       Post.
 */
function experiment_on_post_transition( string $new_status, string $old_status, WP_Post $post ): void {
	$event = post_transition_event( $new_status, $old_status );
	$user  = wp_get_current_user();
	// Events triggers cause have no person behind them: they are not counted.
	if ( null === $event || ! $user->exists() || trigger_running() || ! is_exposed_post_type( $post->post_type ) ) {
		return;
	}
	foreach ( experiments() as $spec_id => $experiment ) {
		if ( ( $experiment['metric'] ?? null ) !== $event ) {
			continue;
		}
		$post_version = get_version_post( (string) $spec_id, (int) $experiment['version'] );
		$record       = $post_version ? version_record( $post_version ) : null;
		// Only while the customization can be served at all (not in safe mode, a build for this
		// surface, within its grant): otherwise neither bucket is seeing what is being tested.
		if ( ! $record || null !== not_served_reason( $record, current_surface() ) || ! applies_to_user( $record, $user ) ) {
			continue;
		}
		experiment_record( (string) $spec_id, experiment_bucket( (string) $spec_id, $user->ID, (float) $experiment['share'] ), $user->ID, true );
	}
}

/**
 * Applies the decision rule to every running experiment (daily, and on
 * demand from the REST API).
 *
 * @return array<string, array<string, mixed>> Decisions that ended an experiment, by spec id.
 */
function decide_experiments(): array {
	$ended = array();
	foreach ( experiments() as $spec_id => $experiment ) {
		$decision = experiment_decision( $experiment );
		if ( 'continue' === $decision['action'] ) {
			continue;
		}
		$result = end_experiment( (string) $spec_id, $decision['action'], $decision['reason'], $experiment, __NAMESPACE__ . '\\experiment_decision' );
		if ( ! is_wp_error( $result ) ) {
			$ended[ $spec_id ] = $result;
		}
	}
	return $ended;
}

/**
 * Schedules the daily decision.
 */
function schedule_experiment_tick(): void {
	if ( ! wp_next_scheduled( 'graft_experiments_tick' ) ) {
		wp_schedule_event( time(), 'daily', 'graft_experiments_tick' );
	}
}

/**
 * An experiment as the REST API returns it: settings, counts and the
 * decision the rule would take now.
 *
 * @param array<string, mixed> $experiment Experiment.
 * @return array<string, mixed>
 */
function experiment_output( array $experiment ): array {
	return $experiment + array( 'decision' => experiment_decision( $experiment ) );
}

/**
 * A spec's running experiment as the customizations screen shows it: the
 * experiment, the rule applied to its counts now, and the viewer's bucket,
 * so the screen can say that it is not showing to someone in the baseline.
 * Null when nothing is being tested.
 *
 * @param string $spec_id Spec id.
 * @return array<string, mixed>|null
 */
function experiment_view( string $spec_id ): ?array {
	$experiment = experiment_of( $spec_id );
	if ( ! $experiment ) {
		return null;
	}
	return experiment_output( $experiment ) + array( 'viewer_bucket' => experiment_bucket( $spec_id, get_current_user_id(), (float) $experiment['share'] ) );
}

/**
 * What the customizations screen needs to start an experiment: the metrics
 * (the host's events) and the largest share.
 *
 * @return array{metrics: array<string, string>, maxShare: float}
 */
function experiment_options(): array {
	return array(
		'metrics'  => array_map( static fn( array $event ): string => (string) $event['title'], trigger_events() ),
		'maxShare' => EXPERIMENT_MAX_SHARE,
	);
}

/**
 * REST routes: list, start, end and decide experiments. Administrators only.
 */
function register_experiment_routes(): void {
	$manage = static function (): bool {
		return current_user_can( 'manage_options' );
	};
	register_rest_route(
		REST_NAMESPACE,
		'/experiments',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => static fn() => new WP_REST_Response( array_values( array_map( __NAMESPACE__ . '\experiment_output', experiments() ) ) ),
			'permission_callback' => $manage,
		)
	);
	register_rest_route(
		REST_NAMESPACE,
		'/experiments/decide',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => static fn() => new WP_REST_Response( (object) decide_experiments() ),
			'permission_callback' => $manage,
		)
	);
	register_rest_route(
		REST_NAMESPACE,
		'/specs/(?P<spec_id>[a-z0-9][a-z0-9-]{1,62})/experiment',
		array(
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => static function ( WP_REST_Request $request ) {
					$result = start_experiment( (string) $request['spec_id'], array_intersect_key( $request->get_params(), array_flip( array( 'share', 'metric', 'minPerBucket', 'maxDays' ) ) ) );
					return is_wp_error( $result ) ? $result : new WP_REST_Response( experiment_output( $result ), 201 );
				},
				'permission_callback' => $manage,
			),
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => static function ( WP_REST_Request $request ) {
					$result = end_experiment( (string) $request['spec_id'], (string) $request['outcome'], __( 'Ended by an administrator.', 'graft' ) );
					return is_wp_error( $result ) ? $result : new WP_REST_Response( $result );
				},
				'permission_callback' => $manage,
				'args'                => array(
					'outcome' => array(
						'type'     => 'string',
						'enum'     => array( 'keep', 'revert' ),
						'required' => true,
					),
				),
			),
		)
	);
}

/**
 * Ends an experiment, without a decision, when the version it tests stops
 * being live (superseded by a new version, upgrading, archived): the counts
 * would otherwise mix two customizations. Hooked to graft_spec_transition.
 *
 * @param string  $next    New state.
 * @param string  $state   Previous state.
 * @param string  $event   Event.
 * @param WP_Post $version Version post.
 */
function experiment_on_spec_transition( string $next, string $state, string $event, WP_Post $version ): void {
	if ( 'active' !== $state || 'active' === $next ) {
		return;
	}
	$record     = version_record( $version );
	$experiment = experiment_of( $record['spec_id'] );
	if ( ! $experiment || (int) $experiment['version'] !== $record['version'] ) {
		return;
	}
	// Only the request that claims it records the end.
	$marker = experiment_claim_end( $record['spec_id'], $experiment );
	if ( ! $marker ) {
		return;
	}
	experiment_finish_end( $record['spec_id'], $marker );
	$counts = experiment_counts( $experiment );
	experiment_forget( $record['spec_id'], $experiment );
	record_change(
		'experiment_abandoned',
		$record['spec_id'],
		$record['version'],
		array(
			'reason' => sprintf( 'The version stopped being live (%s).', $event ),
			'counts' => $counts,
		)
	);
}
