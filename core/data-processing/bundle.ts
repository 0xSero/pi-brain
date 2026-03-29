/**
 * @file core/data-processing/bundle.ts
 *
 * Responsibility: Assemble formatted artifacts into a complete ExportBundle
 * with a manifest hash and metadata. The bundle is the unit of upload.
 *
 * Invariants:
 * - The manifest hash covers all artifact contents (SHA-256).
 * - Metadata counts are accurate to the input sessions.
 * - Writing the bundle to disk creates one file per artifact plus a manifest.json.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExportConfig, ExportFormat } from "../configs/types.js";
import type { SanitizedSession } from "../privacy/types.js";
import { format } from "./formatters.js";
import type { ExportArtifact, ExportBundle } from "./types.js";

/**
 * Create an ExportBundle from sanitized sessions and the export config.
 *
 * @param sessions - Sanitized sessions to bundle.
 * @param config - Export configuration specifying formats.
 * @returns A complete ExportBundle with manifest hash.
 */
export function createBundle(
	sessions: ReadonlyArray<SanitizedSession>,
	config: Required<ExportConfig>,
): ExportBundle {
	const formats = config.formats as ReadonlyArray<ExportFormat>;
	const artifacts: ExportArtifact[] = formats.map((f) => format(sessions, f));

	const hashInput = artifacts.map((a) => a.content).join("");
	const manifestHash = createHash("sha256").update(hashInput).digest("hex");

	const messageCount = sessions.reduce((sum, s) => sum + s.messages.length, 0);

	return {
		artifacts,
		manifestHash,
		createdAt: new Date().toISOString(),
		metadata: {
			sessionCount: sessions.length,
			messageCount,
			formats: formats as unknown as ReadonlyArray<string>,
			source: sessions[0]?.source ?? "unknown",
		},
	};
}

/**
 * Write an ExportBundle to disk, creating the output directory if needed.
 *
 * @param bundle - The bundle to write.
 * @param outputDir - Directory to write artifacts into.
 */
export async function writeBundle(bundle: ExportBundle, outputDir: string): Promise<void> {
	await mkdir(outputDir, { recursive: true });

	for (const artifact of bundle.artifacts) {
		await writeFile(join(outputDir, artifact.fileName), artifact.content, "utf-8");
	}

	const manifest = {
		hash: bundle.manifestHash,
		createdAt: bundle.createdAt,
		metadata: bundle.metadata,
		files: bundle.artifacts.map((a) => a.fileName),
	};

	await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
}
