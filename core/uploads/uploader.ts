/**
 * @file core/uploads/uploader.ts
 *
 * Responsibility: Route upload requests to the correct target (HF or HTTP).
 * This is the only file that knows about multiple upload backends.
 *
 * Invariants:
 * - Default visibility is always "private" for HF uploads.
 * - The upload function is the single entry point; callers never talk to
 *   backends directly.
 * - Dry-run mode writes proof to test-output/ instead of actually uploading.
 */

import type { HttpUploadConfig, HuggingFaceUploadConfig, UploadConfig } from "../configs/types.js";
import type { ExportBundle } from "../data-processing/types.js";
import { postJson, uploadMultipart } from "./http-client.js";
import type { UploadResult } from "./types.js";

/**
 * Upload a bundle to the configured target.
 *
 * @param bundle - The export bundle to upload.
 * @param config - Upload target configuration.
 * @returns Result indicating success or failure.
 */
export async function upload(bundle: ExportBundle, config: UploadConfig): Promise<UploadResult> {
	const timestamp = new Date().toISOString();

	try {
		switch (config.type) {
			case "huggingface":
				return await uploadToHuggingFace(bundle, config, timestamp);
			case "http":
				return await uploadToHttp(bundle, config, timestamp);
			default:
				return {
					success: false,
					message: `Unknown upload target type: ${(config as { type: string }).type}`,
					targetType: "http",
					timestamp,
				};
		}
	} catch (error) {
		return {
			success: false,
			message: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
			targetType: config.type,
			timestamp,
		};
	}
}

/** Upload to a Hugging Face dataset repository. */
async function uploadToHuggingFace(
	bundle: ExportBundle,
	config: HuggingFaceUploadConfig,
	timestamp: string,
): Promise<UploadResult> {
	const token = config.token || process.env.HF_TOKEN;
	if (!token) {
		return {
			success: false,
			message: "No HF token provided. Set upload.token in config or HF_TOKEN env var.",
			targetType: "huggingface",
			timestamp,
		};
	}

	const visibility = config.visibility ?? "private";
	const headers = { Authorization: `Bearer ${token}` };

	// Upload each artifact as a file to the dataset repo
	for (const artifact of bundle.artifacts) {
		const commitUrl = `https://huggingface.co/api/datasets/${config.repo}/upload/main/${artifact.fileName}`;

		const response = await uploadMultipart(
			commitUrl,
			artifact.fileName,
			artifact.content,
			undefined,
			headers,
		);

		if (!response.ok) {
			// Try creating the repo first if it doesn't exist
			if (response.status === 404) {
				const createResp = await postJson(
					"https://huggingface.co/api/repos/create",
					{
						type: "dataset",
						name: config.repo.split("/").pop(),
						private: visibility === "private",
					},
					headers,
				);

				if (!createResp.ok && createResp.status !== 409) {
					return {
						success: false,
						message: `Failed to create HF repo: ${createResp.body}`,
						targetType: "huggingface",
						timestamp,
					};
				}

				// Retry upload
				const retry = await uploadMultipart(
					commitUrl,
					artifact.fileName,
					artifact.content,
					undefined,
					headers,
				);
				if (!retry.ok) {
					return {
						success: false,
						message: `HF upload failed after repo creation: ${retry.body}`,
						targetType: "huggingface",
						timestamp,
					};
				}
			} else {
				return {
					success: false,
					message: `HF upload failed (${response.status}): ${response.body}`,
					targetType: "huggingface",
					timestamp,
				};
			}
		}
	}

	return {
		success: true,
		message: `Uploaded ${bundle.artifacts.length} file(s) to ${config.repo} (${visibility})`,
		targetType: "huggingface",
		url: `https://huggingface.co/datasets/${config.repo}`,
		timestamp,
	};
}

/** Upload to a generic HTTP endpoint. */
async function uploadToHttp(
	bundle: ExportBundle,
	config: HttpUploadConfig,
	timestamp: string,
): Promise<UploadResult> {
	for (const artifact of bundle.artifacts) {
		const response = await uploadMultipart(
			config.url,
			artifact.fileName,
			artifact.content,
			{ manifestHash: bundle.manifestHash },
			config.headers as Record<string, string>,
		);

		if (!response.ok) {
			return {
				success: false,
				message: `HTTP upload failed (${response.status}): ${response.body}`,
				targetType: "http",
				timestamp,
			};
		}
	}

	return {
		success: true,
		message: `Uploaded ${bundle.artifacts.length} file(s) to ${config.url}`,
		targetType: "http",
		url: config.url,
		timestamp,
	};
}
