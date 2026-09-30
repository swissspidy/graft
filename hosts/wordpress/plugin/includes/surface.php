<?php
/**
 * The host half of the Graft surface: slots, capabilities, permission scopes
 * and audiences as this WordPress install exposes them. Components are
 * declared by the TypeScript adapter, which merges both halves and
 * normalizes the ability schemas (see hosts/wordpress/adapter).
 *
 * @package Graft
 */

namespace Graft;

/**
 * Mount points a spec can target.
 *
 * Owned slots give a customization its own space; extension slots attach it
 * to an existing wp-admin screen. `anchor` names the host hook or component
 * the slot attaches to, which is what re-anchoring replaces when WordPress
 * moves it.
 *
 * @return array<string, array<string, mixed>>
 */
function surface_slots(): array {
	$menu_parents = array( 'dashboard', 'posts', 'media', 'pages', 'comments', 'appearance', 'plugins', 'users', 'tools', 'settings' );

	$slots = array(
		'admin.page'             => array(
			'kind'        => 'owned',
			'title'       => __( 'Admin page', 'graft' ),
			'description' => __( 'A wp-admin page of its own, linked from the admin menu.', 'graft' ),
			'anchor'      => 'function:add_submenu_page',
			'options'     => array(
				'type'                 => 'object',
				'properties'           => array(
					'menu' => array(
						'type'                 => 'object',
						'properties'           => array(
							'parent' => array(
								'description' => __( 'Menu the page is listed under. Omit for a top-level item.', 'graft' ),
								'enum'        => $menu_parents,
							),
							'title'  => array(
								'type'      => 'string',
								'minLength' => 1,
								'maxLength' => 40,
							),
						),
						'required'             => array( 'title' ),
						'additionalProperties' => false,
					),
				),
				'required'             => array( 'menu' ),
				'additionalProperties' => false,
			),
			'provides'    => array(
				'type'                 => 'object',
				'properties'           => array(),
				'additionalProperties' => false,
			),
		),
		'dashboard.widget'       => array(
			'kind'        => 'owned',
			'title'       => __( 'Dashboard widget', 'graft' ),
			'description' => __( 'A widget on the wp-admin Dashboard.', 'graft' ),
			'screen'      => 'dashboard',
			'anchor'      => 'function:wp_add_dashboard_widget',
			'options'     => array(
				'type'                 => 'object',
				'properties'           => array(
					'title' => array(
						'type'      => 'string',
						'minLength' => 1,
						'maxLength' => 60,
					),
				),
				'required'             => array( 'title' ),
				'additionalProperties' => false,
			),
			'provides'    => array(
				'type'                 => 'object',
				'properties'           => array(),
				'additionalProperties' => false,
			),
		),
		'posts.list.row-actions' => array(
			'kind'        => 'extension',
			'title'       => __( 'Posts list row actions', 'graft' ),
			'description' => __( 'Actions under each post title on the Posts screen.', 'graft' ),
			'screen'      => 'edit-post',
			'anchor'      => 'filter:post_row_actions',
			'options'     => array(
				'type'                 => 'object',
				'properties'           => array(),
				'additionalProperties' => false,
			),
			'provides'    => array(
				'type'                 => 'object',
				'properties'           => array(
					'post' => array(
						'type'                 => 'object',
						'properties'           => array(
							'id'     => array( 'type' => 'integer' ),
							'title'  => array( 'type' => 'string' ),
							'status' => array(
								'type' => 'string',
								'enum' => post_statuses(),
							),
							'type'   => array( 'type' => 'string' ),
							'can'    => array(
								'type'                 => 'object',
								'properties'           => array(
									'edit'    => array( 'type' => 'boolean' ),
									'publish' => array( 'type' => 'boolean' ),
								),
								'required'             => array( 'edit', 'publish' ),
								'additionalProperties' => false,
							),
						),
						'required'             => array( 'id', 'title', 'status', 'type', 'can' ),
						'additionalProperties' => false,
					),
				),
				'required'             => array( 'post' ),
				'additionalProperties' => false,
			),
			'accepts'     => array( 'row-action' ),
		),
		'post.editor.panel'      => array(
			'kind'        => 'extension',
			'title'       => __( 'Post editor panel', 'graft' ),
			'description' => __( 'A panel in the block editor sidebar, for a saved post. Actions that change the post reload the editor, and wait until the post has no unsaved changes.', 'graft' ),
			'screen'      => 'post',
			'anchor'      => 'component:PluginDocumentSettingPanel',
			'options'     => array(
				'type'                 => 'object',
				'properties'           => array(
					'title' => array(
						'type'      => 'string',
						'minLength' => 1,
						'maxLength' => 60,
					),
				),
				'required'             => array( 'title' ),
				'additionalProperties' => false,
			),
			'provides'    => array(
				'type'                 => 'object',
				'properties'           => array(
					'post' => array(
						'type'                 => 'object',
						'properties'           => array(
							'id'      => array( 'type' => 'integer' ),
							'title'   => array(
								'description' => __( 'The title as saved, without formatting.', 'graft' ),
								'type'        => 'string',
							),
							'excerpt' => array(
								'description' => __( 'The excerpt as saved; empty when the post has none.', 'graft' ),
								'type'        => 'string',
							),
							'status'  => array(
								'type' => 'string',
								'enum' => post_statuses(),
							),
							'type'    => array( 'type' => 'string' ),
							'can'     => array(
								'type'                 => 'object',
								'properties'           => array(
									'edit'    => array( 'type' => 'boolean' ),
									'publish' => array( 'type' => 'boolean' ),
								),
								'required'             => array( 'edit', 'publish' ),
								'additionalProperties' => false,
							),
						),
						'required'             => array( 'id', 'title', 'excerpt', 'status', 'type', 'can' ),
						'additionalProperties' => false,
					),
				),
				'required'             => array( 'post' ),
				'additionalProperties' => false,
			),
		),
	);

	/**
	 * Filters the slots in the Graft surface.
	 *
	 * @param array<string, array<string, mixed>> $slots Slots keyed by id.
	 */
	return apply_filters( 'graft_surface_slots', $slots );
}

/**
 * Permission scopes a spec can request, with the WordPress capabilities they
 * map to. Scopes are what an admin approves; they survive host API renames.
 *
 * @return array<string, array<string, mixed>>
 */
function surface_scopes(): array {
	$scopes = array(
		'posts:read'          => array(
			'title' => __( 'See posts you can edit, including drafts and pending posts', 'graft' ),
			'host'  => array( 'edit_posts' ),
		),
		'posts:write'         => array(
			'title' => __( 'Change the title and excerpt of posts you can edit', 'graft' ),
			'host'  => array( 'edit_posts' ),
		),
		'posts.status:write'  => array(
			'title' => __( 'Publish, unpublish or change the status of posts', 'graft' ),
			'host'  => array( 'edit_posts', 'publish_posts' ),
		),
		'site:read'           => array(
			'title' => __( 'See site settings such as the title and address', 'graft' ),
			'host'  => array( 'manage_options' ),
		),
		'users.current:read'  => array(
			'title' => __( 'See your own profile', 'graft' ),
			'host'  => array( 'read' ),
		),
	);

	/**
	 * Filters the permission scopes in the Graft surface.
	 *
	 * @param array<string, array<string, mixed>> $scopes Scopes keyed by id.
	 */
	return apply_filters( 'graft_surface_scopes', $scopes );
}

/**
 * Capability names mapped to the abilities that implement them.
 *
 * Capability names are the stable, host-neutral symbols builds reference.
 * Pointing one at a different ability (for example a core ability that
 * replaces a graft/ one) is a surface change the upgrade ladder handles.
 *
 * @return array<string, array{ability: string, scopes: string[]}>
 */
function surface_capability_map(): array {
	$map = array(
		'posts.list'          => array(
			'ability' => 'graft/posts-list',
			'scopes'  => array( 'posts:read' ),
		),
		'posts.update_status' => array(
			'ability' => 'graft/post-update-status',
			'scopes'  => array( 'posts.status:write' ),
		),
		'posts.update_fields' => array(
			'ability' => 'graft/post-update-fields',
			'scopes'  => array( 'posts:write' ),
		),
		'site.info'           => array(
			'ability' => 'core/get-site-info',
			'scopes'  => array( 'site:read' ),
		),
		'users.current'       => array(
			'ability' => 'core/get-user-info',
			'scopes'  => array( 'users.current:read' ),
		),
	);

	/**
	 * Filters which abilities the Graft surface exposes as capabilities.
	 *
	 * @param array<string, array{ability: string, scopes: string[]}> $map Capability name to ability and scopes.
	 */
	return apply_filters( 'graft_surface_capability_map', $map );
}

/**
 * Builds the host half of the surface from the live ability registry.
 * Capabilities whose ability is not registered on this install are left out.
 *
 * @return array<string, mixed>
 */
function host_surface(): array {
	global $wp_version;

	$capabilities = array();
	foreach ( surface_capability_map() as $name => $entry ) {
		$ability = wp_get_ability( $entry['ability'] );
		if ( ! $ability ) {
			continue;
		}
		$annotations           = $ability->get_meta_item( 'annotations', array() );
		$capabilities[ $name ] = array(
			'kind'        => ! empty( $annotations['readonly'] ) ? 'read' : 'write',
			'description' => $ability->get_description(),
			'input'       => $ability->get_input_schema(),
			'output'      => $ability->get_output_schema(),
			'scopes'      => $entry['scopes'],
			'binding'     => array(
				'ability'     => $ability->get_name(),
				'annotations' => $annotations,
			),
		);
	}

	return array(
		'graft'        => 1,
		'host'         => 'wordpress',
		'hostVersion'  => $wp_version,
		'slots'        => surface_slots(),
		'capabilities' => $capabilities,
		'scopes'       => surface_scopes(),
		'audiences'    => array_keys( wp_roles()->roles ),
	);
}

/**
 * Fingerprint of the host half of the surface, used at runtime to find the
 * surface snapshot this install matches.
 *
 * Human-readable text (titles, descriptions, labels) is left out because it
 * is translated, and so are the WordPress version and the roles, which vary
 * between sites without changing the contract. What remains is structure:
 * slot, capability and scope ids, anchors, schemas and ability bindings.
 *
 * @param array<string, mixed>|null $surface Host surface; computed when null.
 * @return string `sha256:<hex>`
 */
function host_fingerprint( ?array $surface = null ): string {
	$surface = $surface ?? host_surface();
	unset( $surface['hostVersion'], $surface['audiences'], $surface['fingerprint'] );
	return 'sha256:' . hash( 'sha256', (string) wp_json_encode( strip_text( $surface ) ) );
}

/**
 * Removes translatable strings from a nested array.
 *
 * @param mixed $value Value.
 * @return mixed
 */
function strip_text( $value ) {
	if ( ! is_array( $value ) ) {
		return $value;
	}
	foreach ( $value as $key => $item ) {
		if ( in_array( $key, array( 'title', 'description', 'label' ), true ) && is_string( $item ) ) {
			unset( $value[ $key ] );
		} else {
			$value[ $key ] = strip_text( $item );
		}
	}
	return $value;
}
