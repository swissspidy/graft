import type { Slot, Surface } from '@swissspidy/graft-core';

/** The host half of the surface as printed by the plugin (see dump-surface.php). */
export interface HostDump {
	graft: 1;
	host: 'wordpress';
	hostVersion: string;
	slots: Record<string, Slot> | [];
	capabilities: Record<string, Surface['capabilities'][string]> | [];
	scopes: Record<string, Surface['scopes'][string]> | [];
	audiences: string[];
	/** The exposed content model (see includes/content-model.php). */
	model?: WordPressModel;
	fingerprint: string;
}

/** The content model a WordPress surface was generated from. */
export interface WordPressModel {
	postTypes: Record<
		string,
		{
			label: string;
			hierarchical: boolean;
			capabilityType: string;
			editor: boolean;
			/** Meta key to JSON Schema. */
			fields: Record<string, Record<string, unknown>> | [];
			taxonomies: string[];
		}
	>;
	taxonomies: Record<string, { label: string; hierarchical: boolean }> | [];
}
