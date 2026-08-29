import { describe, expect, it } from "vitest";
import { parseCommandEnvelope } from "./validation";

function createTask(title: string) {
  return parseCommandEnvelope({
    actionId: "action-1",
    expectedRevision: 0,
    command: { type: "create_task", title, description: "Description" },
  });
}

describe("command validation", () => {
  it("accepts ordinary single-line Unicode task titles", () => {
    expect(createTask("Ship café support — phase 2").command).toMatchObject({
      type: "create_task",
      title: "Ship café support — phase 2",
    });
  });

  it.each(["trusted\ninstruction", "trusted\rinstruction", "trusted\0instruction", "trusted\tinstruction", "trusted\u2028instruction", "trusted\u2029instruction"])(
    "rejects control characters in task titles",
    (title) => {
      expect(() => createTask(title)).toThrowError(/single line without control characters/);
    },
  );
});
