<?php
/**
 * The site's content model as Graft sees it: the post types customizations
 * may work with, their custom fields and their taxonomies.
 *
 * Which parts of the site are exposed is a decision for whoever maintains
 * the site's code, typically the agency that built it, so it is made with a
 * filter (`graft_content_model`), never in wp-admin. The details (labels,
 * field types, which taxonomies belong to which type) are read from
 * WordPress's own registries, so the surface follows the site's code.
 *
 * @package Graft
 */

namespace Graft;

/**
 * What the site exposes to Graft, before it is checked against the
 * registries: post type => { fields: meta keys, taxonomies: taxonomy names }.
 *
 * @return array<string, array{fields: string[], taxonomies: string[]}>
 */
function exposed_content(): array {
	$exposed = array(
		'post' => array(
			'fields'     => array(),
			'taxonomies' => array( 'category', 'post_tag' ),
		),
		'page' => array(
			'fields'     => array(),
			'taxonomies' => array(),
		),
	);

	/**
	 * Filters which post types, custom fields and taxonomies customizations
	 * may work with.
	 *
	 * Keys are post type names; each entry lists the meta keys (`fields`) and
	 * taxonomies (`taxonomies`) of that type to expose. A post type must show
	 * in wp-admin; a field must be registered with register_post_meta() as a
	 * single string, integer, number or boolean; a taxonomy must be
	 * registered for the type. Anything else is left out.
	 *
	 * Changing this changes the site's surface: customizations built against
	 * the old one are rebuilt, like after a WordPress update.
	 *
	 * @param array<string, array{fields?: string[], taxonomies?: string[]}> $exposed Exposed content.
	 */
	$exposed = apply_filters( 'graft_content_model', $exposed );

	$out = array();
	foreach ( is_array( $exposed ) ? $exposed : array() as $type => $entry ) {
		$out[ (string) $type ] = array(
			'fields'     => array_values( array_map( 'strval', (array) ( $entry['fields'] ?? array() ) ) ),
			'taxonomies' => array_values( array_map( 'strval', (array) ( $entry['taxonomies'] ?? array() ) ) ),
		);
	}
	return $out;
}

/**
 * The content model: exposed post types, their fields and taxonomies, with
 * what the registries say about them. Sorted, so the surface is stable.
 *
 * `postTypes.<type>`: label, hierarchical, capabilityType, editor (whether
 * the block editor edits it), fields (meta key => JSON Schema) and
 * taxonomies. `taxonomies.<taxonomy>`: label and hierarchical.
 *
 * The verification sandbox registers the same model, so checks run against
 * a site that looks like this one (see playground/sandbox/model.php).
 *
 * @return array{postTypes: array<string, array<string, mixed>>, taxonomies: array<string, array<string, mixed>>}
 */
function content_model(): array {
	static $cache = null;
	// Registrations settle by wp_loaded; before that, compute every time.
	if ( null !== $cache && did_action( 'wp_loaded' ) ) {
		return $cache;
	}
	$post_types = array();
	$taxonomies = array();
	foreach ( exposed_content() as $type => $entry ) {
		$object = get_post_type_object( $type );
		if ( ! $object || ! $object->show_ui ) {
			continue;
		}
		$fields = array();
		$meta   = array_merge( get_registered_meta_keys( 'post' ), get_registered_meta_keys( 'post', $type ) );
		foreach ( $entry['fields'] as $key ) {
			$schema = isset( $meta[ $key ] ) ? field_schema( $meta[ $key ] ) : null;
			if ( $schema ) {
				$fields[ $key ] = $schema;
			}
		}
		ksort( $fields );
		$own = array();
		foreach ( $entry['taxonomies'] as $name ) {
			$taxonomy = get_taxonomy( $name );
			if ( ! $taxonomy || ! $taxonomy->show_ui || ! is_object_in_taxonomy( $type, $name ) ) {
				continue;
			}
			$own[]               = $name;
			$taxonomies[ $name ] = array(
				'label'        => (string) $taxonomy->label,
				'hierarchical' => (bool) $taxonomy->hierarchical,
			);
		}
		sort( $own );
		$post_types[ $type ] = array(
			'label'          => (string) $object->label,
			'hierarchical'   => (bool) $object->hierarchical,
			'capabilityType' => is_array( $object->capability_type ) ? (string) $object->capability_type[0] : (string) $object->capability_type,
			'editor'         => (bool) $object->show_in_rest && post_type_supports( $type, 'editor' ),
			'fields'         => (object) $fields,
			'taxonomies'     => $own,
		);
	}
	ksort( $post_types );
	ksort( $taxonomies );
	$model = array(
		'postTypes'  => $post_types,
		'taxonomies' => $taxonomies,
	);
	if ( did_action( 'wp_loaded' ) ) {
		$cache = $model;
	}
	return $model;
}

/**
 * JSON Schema for a registered meta key, or null when Graft cannot expose
 * it: only single scalar values are supported.
 *
 * @param array<string, mixed> $args Registration arguments.
 * @return array<string, mixed>|null
 */
function field_schema( array $args ): ?array {
	$type = $args['type'] ?? 'string';
	if ( empty( $args['single'] ) || ! in_array( $type, array( 'string', 'integer', 'number', 'boolean' ), true ) ) {
		return null;
	}
	$schema = array( 'type' => $type );
	if ( ! empty( $args['description'] ) ) {
		$schema['description'] = (string) $args['description'];
	}
	// Keep the constraints show_in_rest declares; they are what the REST API enforces too.
	$rest = is_array( $args['show_in_rest'] ?? null ) && is_array( $args['show_in_rest']['schema'] ?? null ) ? $args['show_in_rest']['schema'] : array();
	foreach ( array( 'enum', 'format', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern' ) as $keyword ) {
		if ( isset( $rest[ $keyword ] ) ) {
			$schema[ $keyword ] = $rest[ $keyword ];
		}
	}
	return $schema;
}

/**
 * Names of the exposed post types.
 *
 * @param bool $editor Only those the block editor edits.
 * @return string[]
 */
function exposed_post_types( bool $editor = false ): array {
	$types = content_model()['postTypes'];
	if ( $editor ) {
		$types = array_filter(
			$types,
			static function ( array $type ): bool {
				return $type['editor'];
			}
		);
	}
	return array_keys( $types );
}

/**
 * Whether a post type is exposed.
 *
 * @param string $type Post type.
 * @return bool
 */
function is_exposed_post_type( string $type ): bool {
	return in_array( $type, exposed_post_types(), true );
}

/**
 * The exposed fields of a post type: meta key => schema.
 *
 * @param string $type Post type.
 * @return array<string, array<string, mixed>>
 */
function exposed_fields( string $type ): array {
	return (array) ( content_model()['postTypes'][ $type ]['fields'] ?? array() );
}

/**
 * The exposed taxonomies of a post type.
 *
 * @param string $type Post type.
 * @return string[]
 */
function exposed_taxonomies( string $type ): array {
	return content_model()['postTypes'][ $type ]['taxonomies'] ?? array();
}

/**
 * Schema of a post's `meta`: every exposed field of any type, each
 * optional and nullable (null when the post has no value).
 *
 * @return array<string, mixed>
 */
function meta_schema(): array {
	$properties = array();
	foreach ( content_model()['postTypes'] as $type ) {
		foreach ( (array) $type['fields'] as $key => $schema ) {
			if ( ! isset( $properties[ $key ] ) ) {
				$schema['type'] = array( $schema['type'], 'null' );
				if ( isset( $schema['enum'] ) ) {
					$schema['enum'][] = null;
				}
				$properties[ $key ] = $schema;
			}
		}
	}
	ksort( $properties );
	return array(
		'description'          => __( "The post's custom fields that the site exposes, by meta key; null when it has no value.", 'graft' ),
		'type'                 => 'object',
		'properties'           => $properties,
		'additionalProperties' => false,
	);
}

/**
 * `orderby` values for the exposed fields: meta.<key>.
 *
 * @return string[]
 */
function meta_orderby(): array {
	return array_map(
		static function ( string $key ): string {
			return 'meta.' . $key;
		},
		array_keys( meta_schema()['properties'] )
	);
}

/**
 * Schema of a post's `terms`: the terms of each exposed taxonomy.
 *
 * @return array<string, mixed>
 */
function terms_schema(): array {
	$properties = array();
	foreach ( array_keys( content_model()['taxonomies'] ) as $taxonomy ) {
		$properties[ $taxonomy ] = array(
			'type'  => 'array',
			'items' => term_schema( false ),
		);
	}
	return array(
		'description'          => __( "The post's terms in each exposed taxonomy, by taxonomy.", 'graft' ),
		'type'                 => 'object',
		'properties'           => $properties,
		'additionalProperties' => false,
	);
}

/**
 * Schema of a term.
 *
 * @param bool $with_count Include the number of posts.
 * @return array<string, mixed>
 */
function term_schema( bool $with_count ): array {
	$properties = array(
		'id'   => array( 'type' => 'integer' ),
		'name' => array( 'type' => 'string' ),
		'slug' => array( 'type' => 'string' ),
	);
	if ( $with_count ) {
		$properties['count'] = array( 'type' => 'integer' );
	}
	return array(
		'type'                 => 'object',
		'properties'           => $properties,
		'required'             => array_keys( $properties ),
		'additionalProperties' => false,
	);
}

/**
 * A post's exposed field values, typed by their schemas.
 *
 * @param \WP_Post $post Post.
 * @return array<string, mixed>
 */
function post_meta_values( \WP_Post $post ): array {
	$values = array();
	foreach ( exposed_fields( $post->post_type ) as $key => $schema ) {
		if ( ! metadata_exists( 'post', $post->ID, $key ) ) {
			$values[ $key ] = null;
			continue;
		}
		$value = get_post_meta( $post->ID, $key, true );
		switch ( $schema['type'] ) {
			case 'integer':
				$values[ $key ] = (int) $value;
				break;
			case 'number':
				$values[ $key ] = (float) $value;
				break;
			case 'boolean':
				$values[ $key ] = (bool) $value;
				break;
			default:
				$values[ $key ] = (string) $value;
		}
	}
	return $values;
}

/**
 * A post's terms in its exposed taxonomies.
 *
 * @param \WP_Post $post Post.
 * @return array<string, array<int, array{id: int, name: string, slug: string}>>
 */
function post_term_values( \WP_Post $post ): array {
	$values = array();
	foreach ( exposed_taxonomies( $post->post_type ) as $taxonomy ) {
		$terms               = get_the_terms( $post, $taxonomy );
		$values[ $taxonomy ] = is_array( $terms ) ? array_map( __NAMESPACE__ . '\prepare_term_ref', $terms ) : array();
	}
	return $values;
}

/**
 * A term, for ability output.
 *
 * @param \WP_Term $term Term.
 * @return array{id: int, name: string, slug: string}
 */
function prepare_term_ref( \WP_Term $term ): array {
	return array(
		'id'   => (int) $term->term_id,
		'name' => html_entity_decode( $term->name, ENT_QUOTES ),
		'slug' => $term->slug,
	);
}
