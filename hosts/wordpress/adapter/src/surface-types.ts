import type { Slot, Surface } from '@graft/core';

/** The host half of the surface as printed by the plugin (see dump-surface.php). */
export interface HostDump {
	graft: 1;
	host: 'wordpress';
	hostVersion: string;
	slots: Record<string, Slot> | [];
	capabilities: Record<string, Surface['capabilities'][string]> | [];
	scopes: Record<string, Surface['scopes'][string]> | [];
	audiences: string[];
	fingerprint: string;
}
