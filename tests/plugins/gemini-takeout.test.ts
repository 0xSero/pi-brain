import { afterEach, describe, expect, it } from "vitest";
import {
	geminiTakeoutSearchRoots,
	isGeminiActivityFile,
} from "../../plugins/gemini-takeout/index.js";

describe("isGeminiActivityFile", () => {
	it("accepts Spanish and English Takeout names", () => {
		expect(isGeminiActivityFile("MiActividad.html")).toBe(true);
		expect(isGeminiActivityFile("MyActivity.html")).toBe(true);
		expect(isGeminiActivityFile("myactivity.html")).toBe(true);
		expect(isGeminiActivityFile("session-Gemini.html")).toBe(true);
	});

	it("rejects unrelated HTML", () => {
		expect(isGeminiActivityFile("index.html")).toBe(false);
		expect(isGeminiActivityFile("activity.html")).toBe(false);
	});
});

describe("geminiTakeoutSearchRoots", () => {
	const original = process.env.PI_BRAIN_TAKEOUT_DIR;

	afterEach(() => {
		if (original === undefined) delete process.env.PI_BRAIN_TAKEOUT_DIR;
		else process.env.PI_BRAIN_TAKEOUT_DIR = original;
	});

	it("does not include a bare Downloads directory", () => {
		const roots = geminiTakeoutSearchRoots();
		expect(roots.some((dir) => dir.endsWith("/Downloads") && !dir.endsWith("/Downloads/Takeout"))).toBe(
			false,
		);
	});
});
