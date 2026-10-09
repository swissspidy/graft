<?php
/**
 * Model proxy for compiling specs in wp-admin. The compiler runs in the
 * browser (packages/core) and sends each model request here; the request is
 * answered through the WordPress AI client, so provider keys stay in the
 * site's settings and never reach the browser.
 *
 * @package Graft
 */

namespace Graft;

use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/**
 * Registers POST /graft/v1/generate.
 */
function register_generate_route(): void {
	register_rest_route(
		REST_NAMESPACE,
		'/generate',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => __NAMESPACE__ . '\rest_generate',
			// Model calls cost money and compile customizations for the whole site.
			'permission_callback' => static function (): bool {
				return current_user_can( 'manage_options' );
			},
			'args'                => array(
				'purpose' => array(
					'type'     => 'string',
					'enum'     => array( 'checks', 'ui' ),
					'required' => true,
				),
				'system'  => array(
					'type'     => 'string',
					'required' => true,
				),
				'prompt'  => array(
					'type'     => 'string',
					'required' => true,
				),
				'schema'  => array(
					'type'     => 'object',
					'required' => true,
				),
			),
		)
	);
}

/**
 * Answers one structured-output request from the compiler.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error `{ output, model }`.
 */
function rest_generate( WP_REST_Request $request ) {
	$allowed = policy_allows_authoring();
	if ( is_wp_error( $allowed ) ) {
		return $allowed;
	}
	$args = array(
		'purpose' => (string) $request['purpose'],
		'system'  => (string) $request['system'],
		'prompt'  => (string) $request['prompt'],
		'schema'  => $request['schema'],
	);

	/**
	 * Short-circuits model generation, e.g. to script responses in tests or
	 * route requests elsewhere. Return an array `{ output, model }` or a
	 * WP_Error to skip the AI client.
	 *
	 * @param array|WP_Error|null  $response Null to use the AI client.
	 * @param array<string, mixed> $args     purpose, system, prompt, schema.
	 */
	$pre = apply_filters( 'graft_pre_generate', null, $args );
	if ( null !== $pre ) {
		return is_wp_error( $pre ) ? $pre : new WP_REST_Response( $pre );
	}

	if ( ! function_exists( 'wp_ai_client_prompt' ) || ! wp_supports_ai() ) {
		return new WP_Error( 'graft_ai_unavailable', __( 'AI is not available on this site.', 'graft' ), array( 'status' => 501 ) );
	}
	$result = wp_ai_client_prompt( $args['prompt'] )
		->using_system_instruction( $args['system'] )
		->as_json_response( $args['schema'] )
		->generate_text_result();
	if ( is_wp_error( $result ) ) {
		$result->add_data( array( 'status' => 502 ) );
		return $result;
	}
	$output = json_decode( $result->toText(), true );
	if ( null === $output ) {
		return new WP_Error( 'graft_invalid_model_output', __( 'The model did not return valid JSON.', 'graft' ), array( 'status' => 502 ) );
	}
	return new WP_REST_Response(
		array(
			'output' => $output,
			'model'  => $result->getModelMetadata()->getId(),
		)
	);
}
