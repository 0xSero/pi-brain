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

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HttpUploadConfig, HuggingFaceUploadConfig, UploadConfig } from "../configs/types.js";
import type { ExportBundle } from "../data-processing/types.js";
import { postJson, uploadMultipart } from "./http-client.js";
import type { UploadResult } from "./types.js";

const execFileAsync = promisify(execFile);

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
	const gitUpload = await uploadToHuggingFaceWithGit(
		bundle,
		config.repo,
		token,
		visibility,
		timestamp,
	);
	if (gitUpload.success) {
		return {
			success: true,
			message: `Uploaded ${bundle.artifacts.length + 1} file(s) to ${config.repo} (${visibility})`,
			targetType: "huggingface",
			url: `https://huggingface.co/datasets/${config.repo}`,
			timestamp,
		};
	}

	const headers = { Authorization: `Bearer ${token}` };
	const manifestContent = JSON.stringify(
		{
			hash: bundle.manifestHash,
			createdAt: bundle.createdAt,
			metadata: bundle.metadata,
			files: bundle.artifacts.map((artifact) => artifact.fileName),
		},
		null,
		2,
	);
	const commitPayload = {
		summary: `Upload pi-brain export ${timestamp}`,
		description: `Upload ${bundle.artifacts.length} artifact(s) from pi-brain`,
		files: [
			...bundle.artifacts.map((artifact) => ({
				path: artifact.fileName,
				content: artifact.content,
				encoding: "utf-8",
			})),
			{
				path: "manifest.json",
				content: manifestContent,
				encoding: "utf-8",
			},
		],
	};
	const commitUrl = `https://huggingface.co/api/datasets/${config.repo}/commit/main`;

	const commit = async () => postJson(commitUrl, commitPayload, headers);
	let response = await commit();

	if (!response.ok && response.status === 404) {
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

		response = await commit();
	}

	if (!response.ok) {
		return {
			success: false,
			message: `${gitUpload.message}\nFallback API error (${response.status}): ${response.body}`,
			targetType: "huggingface",
			timestamp,
		};
	}

	return {
		success: true,
		message: `Uploaded ${bundle.artifacts.length + 1} file(s) to ${config.repo} (${visibility})`,
		targetType: "huggingface",
		url: `https://huggingface.co/datasets/${config.repo}`,
		timestamp,
	};
}

async function uploadToHuggingFaceWithGit(
	bundle: ExportBundle,
	repo: string,
	token: string,
	visibility: "private" | "public",
	timestamp: string,
): Promise<{ success: true } | { success: false; message: string }> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-brain-hf-"));
	const repoDir = join(tempDir, "repo");
	const headers = { Authorization: `Bearer ${token}` };
	const manifest = JSON.stringify(
		{
			hash: bundle.manifestHash,
			createdAt: bundle.createdAt,
			metadata: bundle.metadata,
			files: bundle.artifacts.map((artifact) => artifact.fileName),
		},
		null,
		2,
	);

	try {
		const createResp = await postJson(
			"https://huggingface.co/api/repos/create",
			{
				type: "dataset",
				name: repo.split("/").pop(),
				private: visibility === "private",
			},
			headers,
		);
		if (!createResp.ok && createResp.status !== 409) {
			return { success: false, message: `Failed to create repo: ${createResp.body}` };
		}

		await execFileAsync(
			"git",
			["clone", `https://user:${token}@huggingface.co/datasets/${repo}`, repoDir],
			{
				env: {
					...process.env,
					GIT_LFS_SKIP_SMUDGE: "1",
				},
				maxBuffer: 50 * 1024 * 1024,
			},
		);
		await execFileAsync("git", ["lfs", "install", "--local"], { cwd: repoDir });
		await execFileAsync("git", ["lfs", "track", "*.jsonl"], { cwd: repoDir });

		for (const entry of await readdir(repoDir, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === ".gitattributes") {
				continue;
			}

			await rm(join(repoDir, entry.name), { recursive: true, force: true });
		}

		for (const artifact of bundle.artifacts) {
			await writeFile(join(repoDir, artifact.fileName), artifact.content, "utf-8");
		}
		await writeFile(join(repoDir, "manifest.json"), manifest, "utf-8");

		const gitEnv = {
			...process.env,
			GIT_AUTHOR_NAME: "pi-brain",
			GIT_AUTHOR_EMAIL: "pi-brain@local",
			GIT_COMMITTER_NAME: "pi-brain",
			GIT_COMMITTER_EMAIL: "pi-brain@local",
		};
		await execFileAsync("git", ["add", "."], { cwd: repoDir, env: gitEnv });

		const status = await execFileAsync("git", ["status", "--porcelain"], {
			cwd: repoDir,
			env: gitEnv,
		});
		if (!status.stdout.trim()) {
			return { success: true };
		}

		await execFileAsync("git", ["commit", "-m", `Upload pi-brain export ${timestamp}`], {
			cwd: repoDir,
			env: gitEnv,
			maxBuffer: 50 * 1024 * 1024,
		});
		await execFileAsync("git", ["push", "origin", "HEAD:main"], {
			cwd: repoDir,
			env: gitEnv,
			maxBuffer: 50 * 1024 * 1024,
		});

		return { success: true };
	} catch (error) {
		const stdout =
			error instanceof Error && "stdout" in error
				? String((error as { stdout?: string }).stdout ?? "")
				: "";
		const stderr =
			error instanceof Error && "stderr" in error
				? String((error as { stderr?: string }).stderr ?? "")
				: "";
		const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
		return {
			success: false,
			message: detail ? `Git/LFS upload failed: ${detail}` : "Git/LFS upload failed",
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
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
