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

add_action( 'wp_abilities_api_categories_init', __NAMESPACE__ . '\register_ability_category' );
add_action( 'wp_abilities_api_init', __NAMESPACE__ . '\register_abilities' );
