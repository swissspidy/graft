<?php
/**
 * The site's content model, reproduced in the verification sandbox. Loaded
 * as a must-use plugin in the sandbox only. The verifier sends the model of
 * the surface a build was made for (`model` op, stored in the
 * graft_sandbox_model option); this registers its post types, fields and
 * taxonomies where WordPress does not have them, and exposes them to Graft
 * like the site does.
 *
 * It is an approximation of the site, not a copy: a post type with its own
 * capability type gets that type's capabilities on every role that has the
 * matching post capabilities, and fields get WordPress's default
 * permissions.
 */

namespace Graft\SandboxModel;

defined( 'ABSPATH' ) || exit;

/**
 * The stored model, or null when the verifier sent none.
 *
 * @return array<string, mixed>|null
 */
function model(): ?array {
	$model = get_option( 'graft_sandbox_model', null );
	return is_array( $model ) ? $model : null;
}

add_action(
	'init',
	static function (): void {
		$model = model();
		if ( ! $model ) {
			return;
		}
		foreach ( (array) ( $model['taxonomies'] ?? array() ) as $name => $taxonomy ) {
			if ( ! taxonomy_exists( $name ) ) {
				register_taxonomy(
					$name,
					array(),
					array(
						'label'        => $taxonomy['label'] ?? $name,
						'hierarchical' => ! empty( $taxonomy['hierarchical'] ),
						'show_ui'      => true,
						'show_in_rest' => true,
					)
				);
			}
		}
		foreach ( (array) ( $model['postTypes'] ?? array() ) as $name => $type ) {
			if ( ! post_type_exists( $name ) ) {
				$capability_type = (string) ( $type['capabilityType'] ?? 'post' );
				register_post_type(
					$name,
					array(
						'label'           => $type['label'] ?? $name,
						'public'          => true,
						'show_ui'         => true,
						'show_in_rest'    => ! empty( $type['editor'] ),
						'hierarchical'    => ! empty( $type['hierarchical'] ),
						'capability_type' => $capability_type,
						'map_meta_cap'    => true,
						'supports'        => array( 'title', 'editor', 'excerpt', 'author', 'custom-fields', 'page-attributes' ),
					)
				);
				grant_capability_type( $capability_type );
			}
			foreach ( (array) ( $type['taxonomies'] ?? array() ) as $taxonomy ) {
				register_taxonomy_for_object_type( $taxonomy, $name );
			}
			$registered = get_registered_meta_keys( 'post', $name );
			foreach ( (array) ( $type['fields'] ?? array() ) as $key => $schema ) {
				if ( isset( $registered[ $key ] ) ) {
					continue;
				}
				$rest = array_intersect_key( (array) $schema, array_flip( array( 'enum', 'format', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern' ) ) );
				register_post_meta(
					$name,
					$key,
					array(
						'type'          => $schema['type'] ?? 'string',
						'description'   => $schema['description'] ?? '',
						'single'        => true,
						'show_in_rest'  => array( 'schema' => $rest + array( 'type' => $schema['type'] ?? 'string' ) ),
						'auth_callback' => static function ( $allowed, $meta_key, $post_id ): bool {
							return current_user_can( 'edit_post', $post_id );
						},
					)
				);
			}
		}
	},
	1
);

/**
 * Gives a custom capability type's primitive capabilities to every role
 * that has the matching post capability.
 *
 * @param string $capability_type Capability type, such as `event`.
 */
function grant_capability_type( string $capability_type ): void {
	if ( in_array( $capability_type, array( 'post', 'page' ), true ) ) {
		return;
	}
	$object = get_post_type_object( 'post' );
	$caps   = (array) get_post_type_capabilities(
		(object) array(
			'capability_type' => array( $capability_type, $capability_type . 's' ),
			'map_meta_cap'    => true,
			'capabilities'    => array(),
		)
	);
	foreach ( wp_roles()->role_objects as $role ) {
		foreach ( $caps as $key => $cap ) {
			$post_cap = $object->cap->$key ?? null;
			if ( is_string( $post_cap ) && $role->has_cap( $post_cap ) && ! $role->has_cap( $cap ) ) {
				$role->add_cap( $cap );
			}
		}
	}
}

add_filter(
	'graft_content_model',
	static function ( array $exposed ): array {
		$model = model();
		if ( ! $model ) {
			return $exposed;
		}
		$exposed = array();
		foreach ( (array) ( $model['postTypes'] ?? array() ) as $name => $type ) {
			$exposed[ $name ] = array(
				'fields'     => array_keys( (array) ( $type['fields'] ?? array() ) ),
				'taxonomies' => (array) ( $type['taxonomies'] ?? array() ),
			);
		}
		return $exposed;
	},
	1000
);
