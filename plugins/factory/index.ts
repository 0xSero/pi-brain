/**
 * @file plugins/factory/index.ts
 *
 * Factory (Droid) source plugin — typed stub.
 * Factory's session storage format is not yet publicly documented.
 * This plugin exists to reserve the slot and provide a clear error
 * when someone tries to use it.
 *
 * Will be implemented when Factory's session format is specified.
 */

import { NotYetSupportedError } from "../../core/index.js";
import type { CanonicalSession, SourcePlugin } from "../../core/index.js";

export const factoryPlugin: SourcePlugin = {
	name: "factory",

	async listSessions(): Promise<string[]> {
		throw new NotYetSupportedError("factory", "listing sessions");
	},

	async loadSession(_ref: string): Promise<CanonicalSession> {
		throw new NotYetSupportedError("factory", "loading sessions");
	},
};

export default factoryPlugin;
