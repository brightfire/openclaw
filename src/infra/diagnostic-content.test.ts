import { expect, it } from "vitest";
import { joinDiagnosticContent, truncateDiagnosticContent } from "./diagnostic-content.js";

// Mirrors the private per-field budget in diagnostic-content.ts; the production
// constant stays unexported because only tests would consume it.
const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

it("joins captured parts on newlines and drops empty ones", () => {
  expect(joinDiagnosticContent(["first answer", "", "second answer"])).toBe(
    "first answer\nsecond answer",
  );
});

it("returns undefined when no part carries content", () => {
  expect(joinDiagnosticContent([])).toBeUndefined();
  expect(joinDiagnosticContent(["", ""])).toBeUndefined();
});

it("bounds the joined content to the diagnostic budget and marks truncation", () => {
  const oversized = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
  const joined = joinDiagnosticContent([oversized, "dropped tail"], "…[truncated]");
  expect(joined).toBeDefined();
  expect(joined?.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
  expect(joined?.endsWith("…[truncated]")).toBe(true);
});

it("never splits a surrogate pair when truncating a single field", () => {
  const oversized = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
  const truncated = truncateDiagnosticContent(oversized);
  expect(truncated.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
  // A trailing high surrogate would mean the emoji was cut in half.
  expect(truncated.charCodeAt(truncated.length - 1)).not.toBe(0xd83d);
});
