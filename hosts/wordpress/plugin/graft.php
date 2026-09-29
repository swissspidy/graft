<?php
/**
 * Plugin Name:       Graft
 * Plugin URI:        https://github.com/swissspidy/graft
 * Description:       Durable, spec-driven customizations. Registers the Graft abilities and publishes the extension surface specs are compiled against.
 * Version:           0.1.0
 * Requires at least: 7.1
 * Requires PHP:      7.4
 * Author:            Pascal Birchler
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       graft
 *
 * @package Graft
 */

namespace Graft;

defined( 'ABSPATH' ) || exit;

const VERSION = '0.1.0';

require_once __DIR__ . '/includes/abilities.php';
require_once __DIR__ . '/includes/surface.php';
require_once __DIR__ . '/includes/current-surface.php';
require_once __DIR__ . '/includes/lifecycle.php';
require_once __DIR__ . '/includes/store.php';
require_once __DIR__ . '/includes/runtime.php';
require_once __DIR__ . '/includes/slots.php';
require_once __DIR__ . '/includes/rest.php';
require_once __DIR__ . '/includes/generate.php';

add_action( 'wp_abilities_api_categories_init', __NAMESPACE__ . '\register_ability_category' );
add_action( 'wp_abilities_api_init', __NAMESPACE__ . '\register_abilities' );
add_action( 'init', __NAMESPACE__ . '\register_post_types' );
add_action( 'rest_api_init', __NAMESPACE__ . '\register_routes' );
add_action( 'rest_api_init', __NAMESPACE__ . '\register_generate_route' );
add_action( 'admin_menu', __NAMESPACE__ . '\mount_admin_pages' );
add_action( 'wp_dashboard_setup', __NAMESPACE__ . '\mount_dashboard_widgets' );
add_filter( 'post_row_actions', __NAMESPACE__ . '\mount_row_actions', 10, 2 );
add_action( 'admin_footer', __NAMESPACE__ . '\enqueue_runtime' );
add_action( 'admin_init', __NAMESPACE__ . '\check_surface_change' );
add_action( 'rest_api_init', __NAMESPACE__ . '\check_surface_change' );
add_action( 'admin_notices', __NAMESPACE__ . '\surface_change_notice' );
add_action( 'admin_menu', __NAMESPACE__ . '\register_admin_screen' );
