<?php
/**
 * Triggers (ADR 0010): what a customization does without a viewer, on a
 * schedule or when something happens on the site.
 *
 * A trigger runs as the site's automation user, a user with no role whose
 * capabilities are granted only while one of its runs is in progress, and
 * only those the trigger's approved scopes map to. Every call it makes goes
 * through the same gateway checks as a viewer's, against the trigger's own
 * grant. Runs are bounded (a minimum interval, a per-run cap, a rate for
 * event triggers), can be paused one by one or all at once, and every run
 * and every refusal is logged for administrators.
 *
 * The runner evaluates a trigger the way the TypeScript core's runTrigger()
 * does; fixtures/triggers/expressions.json keeps the two in step.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;
use WP_Post;
use WP_User;

/** Login of the site's automation user. */
const SERVICE_LOGIN = 'graft-automation';

/** Runs kept in the log for administrators. */
const MAX_LOGGED_RUNS = 200;

/** Consecutive failed runs after which a trigger pauses itself. */
const MAX_FAILED_RUNS = 3;

/** Targets a trigger remembers having acted on (`once`). */
const MAX_HANDLED = 2000;

/**
 * Events triggers may run on: when a post is published or submitted for
 * review. The post is the event's subject, and the trigger's one target.
 *
 * @return array<string, array<string, mixed>>
 */
function trigger_events(): array {
	return array(
		'post.published' => array(
			'title'       => __( 'A post is published', 'graft' ),
			'description' => __( 'A post of an exposed type changes to published (also when it is scheduled and its time comes).', 'graft' ),
			'provides'    => event_subject_schema(),
		),
		'post.submitted' => array(
			'title'       => __( 'A post is submitted for review', 'graft' ),
			'description' => __( 'A post of an exposed type changes to pending.', 'graft' ),
			'provides'    => event_subject_schema(),
		),
	);
}

/**
 * The trigger half of the surface: the events and capabilities triggers
 * may use, and the bounds every trigger runs within. Null when the site
 * runs no triggers.
 *
 * @return array<string, mixed>|null
 */
function surface_triggers(): ?array {
	$unattended = array( 'posts.list', 'terms.list', 'posts.set_terms', 'posts.update_fields', 'posts.update_meta', 'posts.update_status' );
	$map        = surface_capability_map();
	$triggers   = array(
		'minInterval'         => HOUR_IN_SECONDS,
		'maxPerRun'           => 50,
		'maxEventRunsPerHour' => 60,
		// Site settings and the viewer's profile mean nothing to the automation user.
		'capabilities'        => array_values(
			array_filter(
				$unattended,
				static function ( string $name ) use ( $map ): bool {
					return isset( $map[ $name ] ) && wp_has_ability( $map[ $name ]['ability'] );
				}
			)
		),
		'events'              => trigger_events(),
	);

	/**
	 * Filters what customizations may do without a viewer. Return null to
	 * run no triggers on this site; the policy (graft_policy) can also
	 * forbid or narrow them.
	 *
	 * Changing this changes the site's surface: customizations built
	 * against the old one are rebuilt, like after a WordPress update.
	 *
	 * @param array<string, mixed>|null $triggers {
	 *     @type int      $minInterval         Shortest schedule, in seconds. Default one hour (the runner's tick).
	 *     @type int      $maxPerRun           Most calls one run makes. Default 50.
	 *     @type int      $maxEventRunsPerHour Most runs an event trigger starts in an hour. Default 60.
	 *     @type string[] $capabilities        Capabilities triggers may call.
	 *     @type array    $events              Events triggers may run on.
	 * }
	 */
	$triggers = apply_filters( 'graft_surface_triggers', $triggers );
	return is_array( $triggers ) ? $triggers : null;
}

/**
 * Schema of an event's subject: a post as posts.list returns it, without
 * what the viewer may do with it (there is no viewer).
 *
 * @return array<string, mixed>
 */
function event_subject_schema(): array {
	return array(
		'type'                 => 'object',
		'properties'           => array(
			'id'       => array( 'type' => 'integer' ),
			'title'    => array( 'type' => 'string' ),
			'status'   => array(
				'type' => 'string',
				'enum' => post_statuses(),
			),
			'type'     => array( 'type' => 'string' ),
			'author'   => array(
				'type'                 => 'object',
				'properties'           => array(
					'id'   => array( 'type' => 'integer' ),
					'name' => array( 'type' => 'string' ),
				),
				'required'             => array( 'id', 'name' ),
				'additionalProperties' => false,
			),
			'date'     => array(
				'type'   => 'string',
				'format' => 'date-time',
			),
			'modified' => array(
				'type'   => 'string',
				'format' => 'date-time',
			),
			'meta'     => meta_schema(),
			'terms'    => terms_schema(),
		),
		'required'             => array( 'id', 'title', 'status', 'type', 'author', 'date', 'modified', 'meta', 'terms' ),
		'additionalProperties' => false,
	);
}

/**
 * An event's subject for a post.
 *
 * @param WP_Post $post Post.
 * @return array<string, mixed>
 */
function event_subject( WP_Post $post ): array {
	$subject = prepare_post( $post );
	unset( $subject['can'], $subject['edit_url'] );
	return $subject;
}

/*
 * The automation user.
 */

/**
 * The automation user's id, created when it does not exist yet. It has no
 * role, cannot log in and has no application passwords: it only ever acts
 * inside a trigger run.
 *
 * @return int
 */
function service_user_id(): int {
	$user = get_user_by( 'login', SERVICE_LOGIN );
	if ( $user ) {
		return $user->ID;
	}
	$id = wp_insert_user(
		array(
			'user_login'   => SERVICE_LOGIN,
			'user_pass'    => wp_generate_password( 64, true, true ),
			'display_name' => __( 'Graft automation', 'graft' ),
			'role'         => '',
		)
	);
	return is_wp_error( $id ) ? 0 : (int) $id;
}

/**
 * Whether a user is the automation user.
 *
 * @param mixed $user User, id or login result.
 * @return bool
 */
function is_service_user( $user ): bool {
	$login = $user instanceof WP_User ? $user->user_login : '';
	return SERVICE_LOGIN === $login;
}

/**
 * Refuses logging in as the automation user (hooked to authenticate, late).
 *
 * @param WP_User|WP_Error|null $user Result so far.
 * @return WP_User|WP_Error|null
 */
function refuse_service_login( $user ) {
	if ( is_service_user( $user ) ) {
		return new WP_Error( 'graft_service_user', __( 'This account only runs customizations; nobody can sign in with it.', 'graft' ) );
	}
	return $user;
}

/**
 * No application passwords for the automation user.
 *
 * @param bool    $available Whether they are available.
 * @param WP_User $user      User.
 * @return bool
 */
function no_service_app_passwords( bool $available, $user ): bool {
	return is_service_user( $user ) ? false : $available;
}

/**
 * Capabilities the automation user has right now: those of the run in
 * progress, if any.
 *
 * @param string[]|null $set Capabilities to set (an empty array ends the run's).
 * @return string[]
 */
function service_caps( ?array $set = null ): array {
	static $caps = array();
	if ( null !== $set ) {
		$caps = $set;
	}
	return $caps;
}

/**
 * Grants the automation user the run's capabilities (hooked to
 * user_has_cap). Everyone else is untouched, and outside a run the
 * automation user has none.
 *
 * @param array<string, bool> $allcaps Capabilities the user has.
 * @param string[]            $caps    Requested primitive capabilities.
 * @param array<int, mixed>   $args    Arguments.
 * @param WP_User             $user    User.
 * @return array<string, bool>
 */
function service_user_has_cap( array $allcaps, array $caps, array $args, $user ): array {
	if ( ! is_service_user( $user ) ) {
		return $allcaps;
	}
	$granted = array();
	foreach ( service_caps() as $cap ) {
		$granted[ $cap ] = true;
	}
	return $granted;
}

/**
 * The WordPress capabilities a set of scopes gives the automation user. A
 * scope maps to capabilities a person would hold (edit_posts); the
 * automation user works on everyone's posts, so it gets those
 * capabilities for every exposed post type, with their "others" variants,
 * and the right to assign terms in exposed taxonomies for
 * posts.terms:write. Never anything that manages the site.
 *
 * @param string[] $scopes Granted scopes.
 * @return string[]
 */
function trigger_wp_caps( array $scopes ): array {
	$defined = surface_scopes();
	$host    = array();
	foreach ( $scopes as $scope ) {
		$host = array_merge( $host, (array) ( $defined[ $scope ]['host'] ?? array() ) );
	}
	$caps = array( 'read' );
	foreach ( exposed_post_types() as $type ) {
		$object = get_post_type_object( $type );
		if ( ! $object ) {
			continue;
		}
		if ( in_array( 'edit_posts', $host, true ) ) {
			foreach ( array( 'edit_posts', 'edit_others_posts', 'edit_published_posts', 'edit_private_posts', 'read_private_posts' ) as $cap ) {
				$caps[] = $object->cap->$cap;
			}
		}
		if ( in_array( 'publish_posts', $host, true ) ) {
			$caps[] = $object->cap->publish_posts;
		}
	}
	if ( in_array( 'posts.terms:write', $scopes, true ) ) {
		foreach ( array_keys( content_model()['taxonomies'] ) as $taxonomy ) {
			$object = get_taxonomy( $taxonomy );
			if ( $object ) {
				$caps[] = $object->cap->assign_terms;
			}
		}
	}
	return array_values( array_unique( array_diff( $caps, array( 'manage_options', 'edit_users', 'activate_plugins', 'install_plugins', 'edit_plugins', 'unfiltered_html' ) ) ) );
}

/**
 * Whether a trigger run is in progress (events it causes do not start
 * other triggers).
 *
 * @param bool|null $set Set the flag.
 * @return bool
 */
function trigger_running( ?bool $set = null ): bool {
	static $running = false;
	if ( null !== $set ) {
		$running = $set;
	}
	return $running;
}

/**
 * Runs a callback as the automation user with the capabilities a grant
 * maps to, then puts the previous user and capabilities back.
 *
 * @param string[] $scopes   Granted scopes.
 * @param callable $callback Callback.
 * @return mixed What the callback returns.
 */
function as_service_user( array $scopes, callable $callback ) {
	$previous = get_current_user_id();
	$id       = service_user_id();
	service_caps( trigger_wp_caps( $scopes ) );
	trigger_running( true );
	wp_set_current_user( $id );
	try {
		return $callback();
	} finally {
		service_caps( array() );
		trigger_running( false );
		wp_set_current_user( $previous );
	}
}

/*
 * Evaluation.
 */

/**
 * Evaluates a trigger's where or input for a target, as the core's
 * evaluate() does: `$target`, the logic operators, comparisons, `$if` and
 * `$daysSince`. Only `true` counts as true.
 *
 * @param mixed $value  Value.
 * @param mixed $target The target.
 * @param float $now    The run's clock, in seconds since the epoch.
 * @return mixed
 */
function evaluate_trigger_value( $value, $target, float $now ) {
	if ( ! is_array( $value ) ) {
		return $value;
	}
	if ( array_is_list_compat( $value ) ) {
		return array_map(
			static function ( $item ) use ( $target, $now ) {
				return evaluate_trigger_value( $item, $target, $now );
			},
			$value
		);
	}
	$eval = static function ( $item ) use ( $target, $now ) {
		return evaluate_trigger_value( $item, $target, $now );
	};
	if ( isset( $value['$target'] ) && is_string( $value['$target'] ) ) {
		return value_at_path( $target, $value['$target'] );
	}
	if ( array_key_exists( '$eq', $value ) && is_array( $value['$eq'] ) ) {
		$items = array_map( $eval, array_values( $value['$eq'] ) );
		return canonical_json( $items[0] ?? null ) === canonical_json( $items[1] ?? null );
	}
	foreach ( array( '$gt', '$gte', '$lt', '$lte' ) as $op ) {
		if ( isset( $value[ $op ] ) && is_array( $value[ $op ] ) && 2 === count( $value[ $op ] ) ) {
			list( $a, $b ) = array_map( $eval, array_values( $value[ $op ] ) );
			$numbers       = ( is_int( $a ) || is_float( $a ) ) && ( is_int( $b ) || is_float( $b ) );
			if ( ! $numbers && ! ( is_string( $a ) && is_string( $b ) ) ) {
				return false;
			}
			$cmp = $numbers ? $a <=> $b : strcmp( $a, $b ) <=> 0;
			switch ( $op ) {
				case '$gt':
					return $cmp > 0;
				case '$gte':
					return $cmp >= 0;
				case '$lt':
					return $cmp < 0;
				default:
					return $cmp <= 0;
			}
		}
	}
	if ( isset( $value['$if'] ) && is_array( $value['$if'] ) && 3 === count( $value['$if'] ) ) {
		list( $condition, $then, $otherwise ) = array_values( $value['$if'] );
		return $eval( true === $eval( $condition ) ? $then : $otherwise );
	}
	if ( array_key_exists( '$daysSince', $value ) ) {
		$date = $eval( $value['$daysSince'] );
		$time = is_string( $date ) ? strtotime( $date ) : false;
		return false === $time ? null : (int) floor( ( $now - $time ) / DAY_IN_SECONDS );
	}
	if ( isset( $value['$and'] ) && is_array( $value['$and'] ) ) {
		foreach ( $value['$and'] as $item ) {
			if ( true !== $eval( $item ) ) {
				return false;
			}
		}
		return true;
	}
	if ( isset( $value['$or'] ) && is_array( $value['$or'] ) ) {
		foreach ( $value['$or'] as $item ) {
			if ( true === $eval( $item ) ) {
				return true;
			}
		}
		return false;
	}
	if ( array_key_exists( '$not', $value ) ) {
		return true !== $eval( $value['$not'] );
	}
	return array_map( $eval, $value );
}

/**
 * Whether an array is a list (array_is_list() is PHP 8.1+). An empty array
 * counts as a list.
 *
 * @param array<mixed> $value Array.
 * @return bool
 */
function array_is_list_compat( array $value ): bool {
	return array() === $value || array_keys( $value ) === range( 0, count( $value ) - 1 );
}

/**
 * Reads a dotted path (`author.name`, `terms.post_tag.0.slug`), like the
 * core's getPath(). Null when it is not there.
 *
 * @param mixed  $value Value.
 * @param string $path  Path.
 * @return mixed
 */
function value_at_path( $value, string $path ) {
	if ( '' === $path ) {
		return $value;
	}
	foreach ( explode( '.', $path ) as $segment ) {
		if ( is_object( $value ) ) {
			$value = get_object_vars( $value );
		}
		if ( ! is_array( $value ) || ! array_key_exists( $segment, $value ) ) {
			return null;
		}
		$value = $value[ $segment ];
	}
	return $value;
}

/**
 * JSON with object keys sorted, like the core's canonicalJson(), for
 * equality.
 *
 * @param mixed $value Value.
 * @return string
 */
function canonical_json( $value ): string {
	$sort = static function ( $item ) use ( &$sort ) {
		if ( is_object( $item ) ) {
			$item = get_object_vars( $item );
			if ( array() === $item ) {
				return new \stdClass();
			}
		}
		if ( ! is_array( $item ) ) {
			return $item;
		}
		if ( ! array_is_list_compat( $item ) ) {
			ksort( $item, SORT_STRING );
		}
		return array_map( $sort, $item );
	};
	return (string) wp_json_encode( $sort( $value ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION );
}

/*
 * Running.
 */

/**
 * Capabilities a trigger calls: its targets' read and its action.
 *
 * @param array<string, mixed> $trigger Trigger.
 * @return string[]
 */
function trigger_capabilities( array $trigger ): array {
	$names = array( (string) ( $trigger['call'] ?? '' ) );
	if ( isset( $trigger['targets']['call'] ) ) {
		$names[] = (string) $trigger['targets']['call'];
	}
	$names = array_values( array_unique( $names ) );
	sort( $names );
	return $names;
}

/**
 * Scopes a trigger's calls need, from the host's capability map (never
 * from the build).
 *
 * @param array<string, mixed> $trigger Trigger.
 * @return string[]
 */
function trigger_scopes( array $trigger ): array {
	$map    = surface_capability_map();
	$scopes = array();
	foreach ( trigger_capabilities( $trigger ) as $name ) {
		$scopes = array_merge( $scopes, $map[ $name ]['scopes'] ?? array( 'unknown:write' ) );
	}
	$scopes = array_values( array_unique( $scopes ) );
	sort( $scopes );
	return $scopes;
}

/**
 * The gateway for a trigger's calls. In order: the trigger uses the
 * capability, the host lets triggers use it, the trigger's grant covers
 * its scopes, and the policy allows it as it is now. Only then does the
 * ability run, as the automation user, with its own permission check on
 * top. Refusals go to the gateway's log.
 *
 * @param string               $spec_id    Spec id.
 * @param string               $id         Trigger id.
 * @param array<string, mixed> $trigger    Trigger.
 * @param string               $capability Capability.
 * @param mixed                $input      Input.
 * @param string[]             $grant      The trigger's granted scopes.
 * @param bool                 $managed    Whether the site's maintainer ships the customization.
 * @return mixed|WP_Error
 */
function trigger_call( string $spec_id, string $id, array $trigger, string $capability, $input, array $grant, bool $managed ) {
	$refuse = static function ( string $code, string $message ) use ( $spec_id, $capability, $id ) {
		return audit_refusal( $spec_id, $capability, new WP_Error( $code, $message, array( 'status' => 403 ) ), array( 'trigger' => $id ) );
	};
	if ( ! in_array( $capability, trigger_capabilities( $trigger ), true ) ) {
		return $refuse( 'graft_capability_not_in_trigger', __( 'This trigger does not use that capability.', 'graft' ) );
	}
	$map        = surface_capability_map();
	$unattended = surface_triggers()['capabilities'] ?? array();
	if ( ! isset( $map[ $capability ] ) || ! in_array( $capability, $unattended, true ) ) {
		return $refuse( 'graft_capability_not_unattended', __( 'Triggers may not use that capability on this site.', 'graft' ) );
	}
	if ( array() !== array_diff( $map[ $capability ]['scopes'], $grant ) ) {
		return $refuse( 'graft_not_granted', __( 'This trigger has not been granted that permission.', 'graft' ) );
	}
	if ( ! $managed ) {
		foreach ( array( policy_allows_scopes( $map[ $capability ]['scopes'] ), policy_allows_trigger_scopes( $map[ $capability ]['scopes'] ) ) as $allowed ) {
			if ( is_wp_error( $allowed ) ) {
				return audit_refusal( $spec_id, $capability, $allowed, array( 'trigger' => $id ) );
			}
		}
	}
	$ability = wp_get_ability( $map[ $capability ]['ability'] );
	if ( ! $ability ) {
		return new WP_Error( 'graft_capability_unavailable', __( 'That capability is not available on this site.', 'graft' ) );
	}
	return $ability->execute( $input );
}

/**
 * Runs one trigger once, as the core's runTrigger() does: reads its
 * targets (or takes the event's subject), keeps those its condition holds
 * for and that it has not acted on before (`once`), and calls its
 * capability once per target up to the cap. Call it inside
 * as_service_user().
 *
 * @param array<string, mixed> $build   Build.
 * @param string               $id      Trigger id.
 * @param array<string, mixed> $options {
 *     @type string[] $grant    The trigger's granted scopes.
 *     @type int      $limit    Most calls.
 *     @type float    $now      The run's clock, in seconds.
 *     @type mixed    $subject  An event trigger's subject.
 *     @type string[] $handled  Ids acted on before (`once`).
 *     @type bool     $dry_run  Plan the calls without making them.
 *     @type string   $spec_id  Spec id, for the log.
 *     @type bool     $managed  The site's maintainer ships the customization.
 * }
 * @return array<string, mixed> The run (as TriggerRun in the core) and `handled`: the ids now acted on.
 */
function execute_trigger( array $build, string $id, array $options ): array {
	$trigger = $build['triggers'][ $id ] ?? null;
	$dry_run = ! empty( $options['dry_run'] );
	$run     = array(
		'trigger' => $id,
		'status'  => $dry_run ? 'dry-run' : 'ok',
		'targets' => 0,
		'matched' => 0,
		'skipped' => 0,
		'calls'   => array(),
	);
	$handled = array_map( 'strval', (array) ( $options['handled'] ?? array() ) );
	if ( ! is_array( $trigger ) ) {
		return $run + array(
			'error'   => 'No such trigger.',
			'handled' => $handled,
		);
	}
	$now   = (float) ( $options['now'] ?? time() );
	$limit = max( 0, (int) ( $options['limit'] ?? 1 ) );
	$call  = static function ( string $capability, $input ) use ( $options, $id, $trigger ) {
		return trigger_call( (string) ( $options['spec_id'] ?? '' ), $id, $trigger, $capability, $input, (array) ( $options['grant'] ?? array() ), ! empty( $options['managed'] ) );
	};

	if ( isset( $trigger['targets'] ) ) {
		$path   = (string) ( $trigger['targets']['items'] ?? 'items' );
		$result = $call( (string) $trigger['targets']['call'], evaluate_trigger_value( $trigger['targets']['input'] ?? null, null, $now ) );
		$items  = is_wp_error( $result ) ? null : value_at_path( json_decode( (string) wp_json_encode( $result ), true ), $path );
		if ( ! is_array( $items ) || ! array_is_list_compat( $items ) ) {
			$run['status'] = 'failed';
			$run['error']  = sprintf(
				/* translators: %s: why. */
				__( 'Reading the targets failed: %s', 'graft' ),
				is_wp_error( $result ) ? $result->get_error_message() : sprintf( '"%s" did not return a list at "%s"', $trigger['targets']['call'], $path )
			);
			return $run + array( 'handled' => $handled );
		}
		$targets = $items;
	} else {
		$targets = isset( $options['subject'] ) ? array( json_decode( (string) wp_json_encode( $options['subject'] ), true ) ) : array();
	}
	$run['targets'] = count( $targets );

	$once    = ! empty( $trigger['once'] );
	$matched = array_values(
		array_filter(
			$targets,
			static function ( $target ) use ( $trigger, $once, $handled, $now ): bool {
				if ( $once && in_array( target_key( $target ), $handled, true ) ) {
					return false;
				}
				return ! array_key_exists( 'where', $trigger ) || true === evaluate_trigger_value( $trigger['where'], $target, $now );
			}
		)
	);
	$run['matched'] = count( $matched );
	$run['skipped'] = max( 0, count( $matched ) - $limit );

	$failed = 0;
	foreach ( array_slice( $matched, 0, $limit ) as $target ) {
		$input = evaluate_trigger_value( $trigger['input'] ?? null, $target, $now );
		$entry = array(
			'target' => (object) array_filter(
				array(
					'id'    => is_array( $target ) && ( is_int( $target['id'] ?? null ) || is_string( $target['id'] ?? null ) ) ? $target['id'] : null,
					'title' => is_array( $target ) && is_string( $target['title'] ?? null ) ? $target['title'] : null,
				),
				static fn( $v ) => null !== $v
			),
			'input'  => $input,
			'ok'     => true,
		);
		if ( ! $dry_run ) {
			$result = $call( (string) $trigger['call'], $input );
			if ( is_wp_error( $result ) ) {
				$entry['ok']    = false;
				$entry['error'] = $result->get_error_message();
				++$failed;
			} elseif ( $once ) {
				$handled[] = target_key( $target );
			}
		}
		$run['calls'][] = $entry;
	}
	if ( ! $dry_run ) {
		$run['status'] = 0 === $failed ? 'ok' : ( count( $run['calls'] ) === $failed ? 'failed' : 'partial' );
	}
	return $run + array( 'handled' => array_slice( array_values( array_unique( $handled ) ), -MAX_HANDLED ) );
}

/**
 * The key `once` remembers a target by: its id.
 *
 * @param mixed $target Target.
 * @return string
 */
function target_key( $target ): string {
	$id = is_array( $target ) ? ( $target['id'] ?? null ) : null;
	return null === $id ? canonical_json( $target ) : (string) $id;
}

/*
 * Stored triggers: which run, their state, and when.
 */

/**
 * Why no trigger runs on the site right now, or null when they may.
 *
 * @return string|null
 */
function triggers_disabled(): ?string {
	if ( defined( 'GRAFT_DISABLE_TRIGGERS' ) && GRAFT_DISABLE_TRIGGERS ) {
		return __( 'Triggers are turned off in the site configuration (GRAFT_DISABLE_TRIGGERS).', 'graft' );
	}
	if ( null === surface_triggers() ) {
		return __( 'This site runs no triggers.', 'graft' );
	}
	if ( false === policy()['triggers'] ) {
		/* translators: %s: who maintains the site. */
		return sprintf( __( '%s does not allow customizations to act on their own.', 'graft' ), maintainer() );
	}
	if ( get_option( 'graft_triggers_paused' ) ) {
		return __( 'An administrator paused all triggers.', 'graft' );
	}
	return null;
}

/**
 * Active customizations with triggers in their build for this surface.
 *
 * @return array<string, array{record: array<string, mixed>, build: array<string, mixed>, managed: bool}> By spec id.
 */
function trigger_specs(): array {
	$current = current_surface();
	$out     = array();
	if ( ! $current ) {
		return $out;
	}
	foreach ( list_specs() as $spec ) {
		if ( ! $spec['active_version'] ) {
			continue;
		}
		$post   = get_version_post( $spec['spec_id'], (int) $spec['active_version'] );
		$record = $post ? version_record( $post ) : null;
		$build  = $record['builds'][ $current['hash'] ]['build'] ?? null;
		if ( $record && 'active' === $record['state'] && is_array( $build ) && ! empty( $build['triggers'] ) ) {
			$out[ $spec['spec_id'] ] = array(
				'record'  => $record,
				'build'   => $build,
				'managed' => null !== $spec['managed_by'],
			);
		}
	}
	return $out;
}

/**
 * Every trigger's state: when it last ran and how, whether it is paused,
 * what it acted on (`once`) and its recent event runs.
 *
 * @return array<string, array<string, mixed>> By "<spec>/<trigger>".
 */
function trigger_states(): array {
	$states = get_option( 'graft_trigger_state', array() );
	return is_array( $states ) ? $states : array();
}

/**
 * Changes one trigger's state.
 *
 * @param string               $key   "<spec>/<trigger>".
 * @param array<string, mixed> $patch Fields to set.
 * @return array<string, mixed> The new state.
 */
function update_trigger_state( string $key, array $patch ): array {
	$states         = trigger_states();
	$states[ $key ] = array_merge( $states[ $key ] ?? array(), $patch );
	update_option( 'graft_trigger_state', $states, false );
	return $states[ $key ];
}

/**
 * Whether a scheduled trigger is due. A schedule without a time runs when
 * its interval has passed since its last run; one with a time runs at the
 * first tick after that time of day (site time zone), once the interval
 * has passed. A trigger that never ran waits for its first slot after it
 * became active.
 *
 * @param array<string, mixed> $schedule Schedule.
 * @param array<string, mixed> $state    State: last_run, since.
 * @param int                  $now      Now.
 * @return bool
 */
function trigger_due( array $schedule, array $state, int $now ): bool {
	$interval = schedule_seconds( $schedule );
	$last     = isset( $state['last_run'] ) ? (int) $state['last_run'] : null;
	$since    = (int) ( $state['since'] ?? $now );
	if ( $interval <= 0 ) {
		return false;
	}
	if ( empty( $schedule['at'] ) ) {
		// Ticks are hourly: a few minutes early is on time.
		return $now - ( $last ?? $since ) >= $interval - 5 * MINUTE_IN_SECONDS;
	}
	$slot = latest_slot( (string) $schedule['at'], $now );
	if ( null === $last ) {
		return $slot > $since;
	}
	return $last < $slot && $now - $last >= $interval - HOUR_IN_SECONDS;
}

/**
 * The latest time of day `at` (HH:MM, site time zone) at or before now.
 *
 * @param string $at  Time of day.
 * @param int    $now Now.
 * @return int
 */
function latest_slot( string $at, int $now ): int {
	$zone  = wp_timezone();
	$today = ( new \DateTimeImmutable( '@' . $now ) )->setTimezone( $zone );
	list( $hour, $minute ) = array_map( 'intval', explode( ':', $at ) );
	$slot = $today->setTime( $hour, $minute );
	if ( $slot->getTimestamp() > $now ) {
		$slot = $slot->modify( '-1 day' );
	}
	return $slot->getTimestamp();
}

/**
 * When a scheduled trigger runs next, roughly (the next tick after that).
 *
 * @param array<string, mixed> $schedule Schedule.
 * @param array<string, mixed> $state    State.
 * @param int                  $now      Now.
 * @return int
 */
function trigger_next_run( array $schedule, array $state, int $now ): int {
	$interval = schedule_seconds( $schedule );
	$last     = isset( $state['last_run'] ) ? (int) $state['last_run'] : null;
	if ( empty( $schedule['at'] ) ) {
		return max( $now, ( $last ?? (int) ( $state['since'] ?? $now ) ) + $interval );
	}
	// The first slot after the interval has (nearly) passed.
	$earliest = null === $last ? (int) ( $state['since'] ?? $now ) : $last + $interval - HOUR_IN_SECONDS;
	return latest_slot( (string) $schedule['at'], max( $now, $earliest ) ) + DAY_IN_SECONDS;
}

/**
 * Seconds between runs of a schedule (`6h`, `1d`), 0 when it is not one.
 *
 * @param array<string, mixed> $schedule Schedule.
 * @return int
 */
function schedule_seconds( array $schedule ): int {
	if ( ! preg_match( '/^([1-9][0-9]{0,2})([hd])$/', (string) ( $schedule['every'] ?? '' ), $match ) ) {
		return 0;
	}
	return (int) $match[1] * ( 'd' === $match[2] ? DAY_IN_SECONDS : HOUR_IN_SECONDS );
}

/**
 * The per-run cap: the spec's limit, within the host's and the policy's.
 *
 * @param array<string, mixed> $record Version record.
 * @param string               $id     Trigger id.
 * @return int
 */
function trigger_limit( array $record, string $id ): int {
	$max    = (int) ( surface_triggers()['maxPerRun'] ?? 1 );
	$policy = policy()['triggers'];
	if ( is_array( $policy ) && isset( $policy['max_per_run'] ) ) {
		$max = min( $max, (int) $policy['max_per_run'] );
	}
	$limit = (int) ( $record['manifest']['triggers'][ $id ]['limit'] ?? $max );
	return max( 1, min( $limit, $max ) );
}

/**
 * Runs a stored customization's trigger: the checks that do not depend on
 * one call (active, granted, policy, paused), then the run as the
 * automation user, then its state and log entry.
 *
 * @param string     $spec_id Spec id.
 * @param string     $id      Trigger id.
 * @param string     $kind    schedule, event or manual.
 * @param mixed      $subject An event trigger's subject.
 * @param bool       $dry_run Plan without calling.
 * @param int|null   $now     Now.
 * @return array<string, mixed>|WP_Error The run as logged.
 */
function run_stored_trigger( string $spec_id, string $id, string $kind, $subject = null, bool $dry_run = false, ?int $now = null ) {
	$now   = $now ?? time();
	$specs = trigger_specs();
	$entry = $specs[ $spec_id ] ?? null;
	$build = $entry['build'] ?? null;
	if ( ! $entry || ! isset( $build['triggers'][ $id ] ) ) {
		return new WP_Error( 'graft_no_trigger', __( 'No active customization has that trigger.', 'graft' ), array( 'status' => 404 ) );
	}
	$key     = $spec_id . '/' . $id;
	$state   = trigger_states()[ $key ] ?? array();
	$record  = $entry['record'];
	$trigger = $build['triggers'][ $id ];
	$grant   = (array) ( $record['grant']['triggers'][ $id ] ?? array() );

	$refused = null;
	if ( ! $dry_run ) {
		$disabled = triggers_disabled();
		if ( null !== $disabled ) {
			$refused = new WP_Error( 'graft_triggers_disabled', $disabled, array( 'status' => 409 ) );
		} elseif ( ! empty( $state['paused'] ) ) {
			$refused = new WP_Error( 'graft_trigger_paused', __( 'This trigger is paused.', 'graft' ), array( 'status' => 409 ) );
		}
	}
	if ( ! $refused && array() !== array_diff( trigger_scopes( $trigger ), $grant ) ) {
		$refused = new WP_Error( 'graft_not_granted', __( 'This trigger has not been granted what it needs.', 'graft' ), array( 'status' => 403 ) );
	}
	if ( ! $refused && ! $entry['managed'] ) {
		$allowed = policy_allows_trigger( $trigger, $grant );
		$refused = is_wp_error( $allowed ) ? $allowed : null;
	}
	if ( $refused ) {
		audit_refusal( $spec_id, (string) $trigger['call'], $refused, array( 'trigger' => $id ) );
		return log_trigger_run(
			array(
				'spec'    => $spec_id,
				'version' => $record['version'],
				'trigger' => $id,
				'kind'    => $kind,
				'status'  => 'refused',
				'error'   => $refused->get_error_message(),
			),
			$now
		);
	}

	$run = as_service_user(
		$grant,
		static function () use ( $build, $id, $grant, $record, $now, $subject, $state, $dry_run, $spec_id, $entry ) {
			return execute_trigger(
				$build,
				$id,
				array(
					'grant'   => $grant,
					'limit'   => trigger_limit( $record, $id ),
					'now'     => $now,
					'subject' => $subject,
					'handled' => $state['handled'] ?? array(),
					'dry_run' => $dry_run,
					'spec_id' => $spec_id,
					'managed' => $entry['managed'],
				)
			);
		}
	);

	if ( ! $dry_run ) {
		$failures = 'failed' === $run['status'] ? (int) ( $state['failures'] ?? 0 ) + 1 : 0;
		$patch    = array(
			'last_run'    => $now,
			'last_status' => $run['status'],
			'handled'     => $run['handled'],
			'failures'    => $failures,
		);
		if ( $failures >= MAX_FAILED_RUNS ) {
			$patch['paused']       = true;
			$patch['pause_reason'] = __( 'Paused after failing three runs in a row.', 'graft' );
		}
		update_trigger_state( $key, $patch );
	}
	unset( $run['handled'] );
	return log_trigger_run(
		array_merge(
			array(
				'spec'    => $spec_id,
				'version' => $record['version'],
				'kind'    => $dry_run ? 'dry-run' : $kind,
			),
			$run
		),
		$now
	);
}

/**
 * Adds a run to the log administrators see, and fires graft_trigger_ran.
 *
 * @param array<string, mixed> $run Run.
 * @param int                  $now When.
 * @return array<string, mixed> The run as logged.
 */
function log_trigger_run( array $run, int $now ): array {
	$run = array_merge(
		array(
			'time' => gmdate( 'c', $now ),
			'user' => service_user_id(),
		),
		$run
	);
	if ( isset( $run['calls'] ) && count( $run['calls'] ) > 50 ) {
		$run['calls'] = array_slice( $run['calls'], 0, 50 );
	}
	$log   = trigger_log();
	$log[] = $run;
	update_option( 'graft_trigger_runs', array_slice( $log, -MAX_LOGGED_RUNS ), false );
	/**
	 * Fires after a trigger ran (or was refused), for site logging.
	 *
	 * @param array<string, mixed> $run time, user, spec, version, trigger, kind, status, targets, matched,
	 *                                  skipped, calls (target, input, ok, error) and error.
	 */
	do_action( 'graft_trigger_ran', $run );
	return $run;
}

/**
 * The latest trigger runs, oldest first.
 *
 * @return array<int, array<string, mixed>>
 */
function trigger_log(): array {
	$log = get_option( 'graft_trigger_runs', array() );
	return is_array( $log ) ? array_values( $log ) : array();
}

/**
 * The hourly tick (WP-Cron): runs every scheduled trigger that is due.
 *
 * @param int|null $now Now.
 * @return array<int, array<string, mixed>> The runs.
 */
function run_due_triggers( ?int $now = null ): array {
	$now = $now ?? time();
	if ( null !== triggers_disabled() ) {
		return array();
	}
	$runs = array();
	foreach ( trigger_specs() as $spec_id => $entry ) {
		foreach ( $entry['build']['triggers'] as $id => $trigger ) {
			if ( ! isset( $trigger['schedule'] ) ) {
				continue;
			}
			$key   = $spec_id . '/' . $id;
			$state = trigger_states()[ $key ] ?? null;
			if ( null === $state ) {
				// First seen: the schedule starts now.
				update_trigger_state( $key, array( 'since' => $now ) );
				continue;
			}
			if ( empty( $state['paused'] ) && trigger_due( $trigger['schedule'], $state, $now ) ) {
				$run = run_stored_trigger( $spec_id, (string) $id, 'schedule', null, false, $now );
				if ( ! is_wp_error( $run ) ) {
					$runs[] = $run;
				}
			}
		}
	}
	return $runs;
}

/**
 * Keeps the hourly tick scheduled (hooked to init).
 */
function schedule_trigger_tick(): void {
	if ( ! wp_next_scheduled( 'graft_triggers_tick' ) ) {
		wp_schedule_event( time(), 'hourly', 'graft_triggers_tick' );
	}
}

/**
 * Turns a post's status change into trigger events (hooked to
 * transition_post_status). Each trigger on the event runs later, in its
 * own WP-Cron job, never in the request of the person who caused it.
 * Events a trigger run causes start nothing, so triggers cannot chain.
 *
 * @param string  $new_status New status.
 * @param string  $old_status Old status.
 * @param WP_Post $post       Post.
 */
function on_post_transition( string $new_status, string $old_status, WP_Post $post ): void {
	$event = null;
	if ( 'publish' === $new_status && 'publish' !== $old_status ) {
		$event = 'post.published';
	} elseif ( 'pending' === $new_status && 'pending' !== $old_status ) {
		$event = 'post.submitted';
	}
	if ( null === $event || trigger_running() || ! is_exposed_post_type( $post->post_type ) || null !== triggers_disabled() ) {
		return;
	}
	foreach ( trigger_specs() as $spec_id => $entry ) {
		foreach ( $entry['build']['triggers'] as $id => $trigger ) {
			if ( ( $trigger['event'] ?? null ) === $event ) {
				wp_schedule_single_event( time(), 'graft_trigger_event', array( $spec_id, (string) $id, $post->ID, $event ) );
			}
		}
	}
}

/**
 * Runs an event trigger for a post (the graft_trigger_event job), within
 * the host's rate for event triggers.
 *
 * @param string $spec_id Spec id.
 * @param string $id      Trigger id.
 * @param int    $post_id Post id.
 * @param string $event   Event.
 * @return array<string, mixed>|WP_Error|null The run, or null when there was nothing to do.
 */
function run_event_trigger( string $spec_id, string $id, int $post_id, string $event ) {
	$post = get_post( $post_id );
	if ( ! $post || ! is_exposed_post_type( $post->post_type ) ) {
		return null;
	}
	$now    = time();
	$key    = $spec_id . '/' . $id;
	$recent = array_values(
		array_filter(
			(array) ( trigger_states()[ $key ]['event_runs'] ?? array() ),
			static fn( $time ) => (int) $time > $now - HOUR_IN_SECONDS
		)
	);
	$rate   = (int) ( surface_triggers()['maxEventRunsPerHour'] ?? 60 );
	if ( count( $recent ) >= $rate ) {
		$entry = trigger_specs()[ $spec_id ] ?? null;
		return log_trigger_run(
			array(
				'spec'    => $spec_id,
				'version' => $entry['record']['version'] ?? null,
				'trigger' => $id,
				'kind'    => 'event',
				'status'  => 'rate-limited',
				/* translators: %d: runs per hour. */
				'error'   => sprintf( __( 'Dropped: this trigger already ran %d times in the last hour.', 'graft' ), $rate ),
			),
			$now
		);
	}
	$recent[] = $now;
	update_trigger_state( $key, array( 'event_runs' => $recent ) );
	return run_stored_trigger( $spec_id, $id, 'event', event_subject( $post ), false, $now );
}

/**
 * The triggers of active customizations as administrators see them: when
 * each runs, what it is granted, its state and next run.
 *
 * @return array<string, mixed>
 */
function admin_triggers(): array {
	$now      = time();
	$states   = trigger_states();
	$triggers = array();
	foreach ( trigger_specs() as $spec_id => $entry ) {
		foreach ( $entry['build']['triggers'] as $id => $trigger ) {
			$state      = $states[ $spec_id . '/' . $id ] ?? array();
			$triggers[] = array(
				'spec'        => $spec_id,
				'title'       => $entry['record']['title'],
				'trigger'     => (string) $id,
				'schedule'    => $trigger['schedule'] ?? null,
				'event'       => $trigger['event'] ?? null,
				'granted'     => array_values( (array) ( $entry['record']['grant']['triggers'][ $id ] ?? array() ) ),
				'limit'       => trigger_limit( $entry['record'], (string) $id ),
				'once'        => ! empty( $trigger['once'] ),
				'paused'      => ! empty( $state['paused'] ),
				'pauseReason' => $state['pause_reason'] ?? null,
				'lastRun'     => isset( $state['last_run'] ) ? gmdate( 'c', (int) $state['last_run'] ) : null,
				'lastStatus'  => $state['last_status'] ?? null,
				'nextRun'     => isset( $trigger['schedule'] ) ? gmdate( 'c', trigger_next_run( $trigger['schedule'], $state + array( 'since' => $now ), $now ) ) : null,
				'managed'     => $entry['managed'],
			);
		}
	}
	return array(
		'disabled' => triggers_disabled(),
		'paused'   => (bool) get_option( 'graft_triggers_paused' ),
		'identity' => __( 'Graft automation', 'graft' ),
		'triggers' => $triggers,
		'runs'     => array_reverse( array_slice( trigger_log(), -50 ) ),
	);
}

/**
 * Registers the trigger routes: the list, pausing one or all, and running
 * one now (for real or as a dry run).
 */
function register_trigger_routes(): void {
	$manage = static function (): bool {
		return current_user_can( 'manage_options' );
	};
	register_rest_route(
		REST_NAMESPACE,
		'/triggers',
		array(
			'methods'             => 'GET',
			'callback'            => static fn() => rest_ensure_response( admin_triggers() ),
			'permission_callback' => $manage,
		)
	);
	register_rest_route(
		REST_NAMESPACE,
		'/triggers/(?P<action>pause-all|resume-all)',
		array(
			'methods'             => 'POST',
			'callback'            => static function ( \WP_REST_Request $request ) {
				update_option( 'graft_triggers_paused', 'pause-all' === $request['action'], false );
				return rest_ensure_response( admin_triggers() );
			},
			'permission_callback' => $manage,
		)
	);
	register_rest_route(
		REST_NAMESPACE,
		'/triggers/(?P<spec_id>[a-z0-9-]+)/(?P<trigger>[a-z][a-z0-9-]*)/(?P<action>pause|resume|run)',
		array(
			'methods'             => 'POST',
			'callback'            => static function ( \WP_REST_Request $request ) {
				$spec_id = (string) $request['spec_id'];
				$id      = (string) $request['trigger'];
				if ( ! isset( trigger_specs()[ $spec_id ]['build']['triggers'][ $id ] ) ) {
					return new WP_Error( 'graft_no_trigger', __( 'No active customization has that trigger.', 'graft' ), array( 'status' => 404 ) );
				}
				if ( 'run' === $request['action'] ) {
					$build   = trigger_specs()[ $spec_id ]['build'];
					$trigger = $build['triggers'][ $id ];
					// An event trigger runs on a post the administrator names.
					$subject = null;
					if ( isset( $trigger['event'] ) ) {
						$post = get_post( (int) $request['post'] );
						if ( ! $post || ! is_exposed_post_type( $post->post_type ) ) {
							return new WP_Error( 'graft_no_subject', __( 'Name the post to run this trigger on.', 'graft' ), array( 'status' => 400 ) );
						}
						$subject = event_subject( $post );
					}
					return rest_ensure_response( run_stored_trigger( $spec_id, $id, 'manual', $subject, (bool) $request['dry_run'] ) );
				}
				$paused = 'pause' === $request['action'];
				update_trigger_state(
					$spec_id . '/' . $id,
					array(
						'paused'       => $paused,
						'pause_reason' => $paused ? __( 'Paused by an administrator.', 'graft' ) : null,
						'failures'     => 0,
					)
				);
				return rest_ensure_response( admin_triggers() );
			},
			'permission_callback' => $manage,
			'args'                => array(
				'dry_run' => array(
					'type'    => 'boolean',
					'default' => false,
				),
				'post'    => array( 'type' => 'integer' ),
			),
		)
	);
}
