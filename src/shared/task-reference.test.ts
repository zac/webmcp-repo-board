import { describe, expect, it } from "vitest";
import { isTaskReference, normalizeTaskReference, taskReferenceCandidate, TASK_REFERENCE_CAPACITY } from "./task-reference";

describe("two-word task references", () => {
  it("produces a deterministic, bounded adjective-noun reference", () => {
    expect(taskReferenceCandidate("task-123")).toBe(taskReferenceCandidate("task-123"));
    expect(taskReferenceCandidate("task-123")).toMatch(/^[a-z]{3,6}-[a-z]{3,6}$/);
    expect(isTaskReference(taskReferenceCandidate("task-123"))).toBe(true);
  });

  it("normalizes the forms humans are likely to type", () => {
    expect(normalizeTaskReference(" Amber Fox ")).toBe("amber-fox");
    expect(normalizeTaskReference("amber_fox")).toBe("amber-fox");
    expect(isTaskReference("Amber Fox")).toBe(true);
  });

  it("can walk the full reference space without repeating a pair", () => {
    expect(TASK_REFERENCE_CAPACITY).toBeGreaterThan(10_000);
    const references = new Set(Array.from({ length: TASK_REFERENCE_CAPACITY }, (_, attempt) => taskReferenceCandidate("task-123", attempt)));
    expect(references.size).toBe(TASK_REFERENCE_CAPACITY);
  });
});
