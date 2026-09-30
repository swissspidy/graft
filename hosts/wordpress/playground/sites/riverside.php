<?php
/**
 * Plugin Name: Riverside Arts Centre (fixture)
 * Description: A client site built by an agency, as its code might look: an
 * events post type with custom fields and an event type taxonomy, and what
 * the agency lets Graft use. Loaded as a must-use plugin by the surface
 * generator (--site), the e2e site and the demo.
 */

namespace Riverside;

defined( 'ABSPATH' ) || exit;

add_action(
	'init',
	static function (): void {
		register_post_type(
			'event',
			array(
				'label'        => 'Events',
				'labels'       => array( 'singular_name' => 'Event' ),
				'public'       => true,
				'show_in_rest' => true,
				'menu_icon'    => 'dashicons-calendar-alt',
				'supports'     => array( 'title', 'editor', 'excerpt', 'author', 'custom-fields' ),
			)
		);
		register_taxonomy(
			'event_type',
			'event',
			array(
				'label'        => 'Event types',
				'hierarchical' => true,
				'show_in_rest' => true,
			)
		);
		$auth = static function ( $allowed, $meta_key, $post_id ): bool {
			return current_user_can( 'edit_post', $post_id );
		};
		register_post_meta(
			'event',
			'event_date',
			array(
				'type'              => 'string',
				'description'       => 'The day the event takes place (YYYY-MM-DD).',
				'single'            => true,
				'show_in_rest'      => array(
					'schema' => array(
						'type'    => 'string',
						'pattern' => '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
					),
				),
				'sanitize_callback' => static function ( $value ): string {
					return preg_match( '/^\d{4}-\d{2}-\d{2}$/', (string) $value ) ? (string) $value : '';
				},
				'auth_callback'     => $auth,
			)
		);
		register_post_meta(
			'event',
			'venue',
			array(
				'type'              => 'string',
				'description'       => 'Where the event takes place.',
				'single'            => true,
				'show_in_rest'      => array(
					'schema' => array(
						'type'      => 'string',
						'maxLength' => 100,
					),
				),
				'sanitize_callback' => 'sanitize_text_field',
				'auth_callback'     => $auth,
			)
		);
		register_post_meta(
			'event',
			'capacity',
			array(
				'type'          => 'integer',
				'description'   => 'How many seats the event has.',
				'single'        => true,
				'show_in_rest'  => array(
					'schema' => array(
						'type'    => 'integer',
						'minimum' => 0,
					),
				),
				'auth_callback' => $auth,
			)
		);
		register_post_meta(
			'event',
			'sold_out',
			array(
				'type'          => 'boolean',
				'description'   => 'Whether every seat is taken.',
				'single'        => true,
				'show_in_rest'  => true,
				'auth_callback' => $auth,
			)
		);
		// Not exposed to Graft: customizations never see it.
		register_post_meta(
			'event',
			'box_office_notes',
			array(
				'type'          => 'string',
				'single'        => true,
				'show_in_rest'  => true,
				'auth_callback' => $auth,
			)
		);
	}
);

// What the agency lets customizations work with: posts, pages and events.
add_filter(
	'graft_content_model',
	static function ( array $exposed ): array {
		$exposed['event'] = array(
			'fields'     => array( 'event_date', 'venue', 'capacity', 'sold_out' ),
			'taxonomies' => array( 'event_type' ),
		);
		return $exposed;
	}
);
