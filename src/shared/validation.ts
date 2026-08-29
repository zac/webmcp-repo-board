import { AGENT_PHASES, ASSIGNMENT_FOCUSES, ASSIGNMENT_KINDS, TASK_COLUMNS, type AgentPhase, type AgentStats, type AssignmentKind, type BoardCommand, type CommandEnvelope } from "./types";

export class ValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "ValidationError";
  }
}

export function parseCommandEnvelope(value: unknown): CommandEnvelope {
  const object = objectValue(value);
  const actionId = boundedString(object.actionId, "actionId", 1, 100);
  const expectedRevision = integerValue(object.expectedRevision, "expectedRevision", 0);
  const commandObject = objectValue(object.command);
  const type = boundedString(commandObject.type, "command.type", 1, 50);
  let command: BoardCommand;

  switch (type) {
    case "create_task":
      command = { type, title: singleLineString(commandObject.title, "title", 1, 120), description: boundedString(commandObject.description ?? "", "description", 0, 10_000) };
      break;
    case "edit_task":
      command = { type, taskId: identifier(commandObject.taskId, "taskId"), title: singleLineString(commandObject.title, "title", 1, 120), description: boundedString(commandObject.description ?? "", "description", 0, 10_000) };
      break;
    case "claim_task":
      command = {
        type,
        taskId: identifier(commandObject.taskId, "taskId"),
        kind: enumValue(commandObject.kind, ASSIGNMENT_KINDS, "kind"),
        ...(commandObject.focus === undefined ? {} : { focus: enumValue(commandObject.focus, ASSIGNMENT_FOCUSES, "focus") }),
        agentLabel: boundedString(commandObject.agentLabel, "agentLabel", 1, 80),
      };
      break;
    case "report_progress":
      command = { type, assignmentId: identifier(commandObject.assignmentId, "assignmentId"), phase: enumValue(commandObject.phase, AGENT_PHASES, "phase"), summary: boundedString(commandObject.summary, "summary", 1, 500), stats: parseStats(commandObject.stats) };
      break;
    case "set_plan":
    case "set_plan_and_start_work":
    case "update_plan":
      command = { type, assignmentId: identifier(commandObject.assignmentId, "assignmentId"), markdown: boundedString(commandObject.markdown, "markdown", 1, 20_000) };
      break;
    case "start_work":
    case "renew_assignment":
    case "release_task":
      command = { type, assignmentId: identifier(commandObject.assignmentId, "assignmentId") };
      break;
    case "link_pull_request":
      command = { type, assignmentId: identifier(commandObject.assignmentId, "assignmentId"), url: boundedString(commandObject.url, "url", 1, 500) };
      break;
    case "archive_task":
      command = { type, taskId: identifier(commandObject.taskId, "taskId") };
      break;
    case "cancel_task":
      command = { type, taskId: identifier(commandObject.taskId, "taskId"), reason: boundedString(commandObject.reason, "reason", 1, 500) };
      break;
    default:
      throw new ValidationError("unknown_command", "Command type is not supported");
  }
  return { actionId, expectedRevision, command };
}

export function parseTaskColumn(value: unknown): (typeof TASK_COLUMNS)[number] {
  return enumValue(value, TASK_COLUMNS, "column");
}

function parseStats(value: unknown): AgentStats {
  if (value === undefined || value === null) return {};
  const object = objectValue(value);
  const stats: AgentStats = {};
  for (const key of ["filesChanged", "commits", "testsPassed", "testsFailed"] as const) {
    if (object[key] !== undefined) stats[key] = integerValue(object[key], key, 0, 100_000);
  }
  return stats;
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("invalid_object", "Expected a JSON object");
  return value as Record<string, unknown>;
}

export function boundedString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ValidationError("invalid_string", `${name} must be a string`);
  const result = value.trim();
  if (result.length < min || result.length > max) throw new ValidationError("invalid_length", `${name} must contain ${min} to ${max} characters`);
  return result;
}

export function singleLineString(value: unknown, name: string, min: number, max: number): string {
  const result = boundedString(value, name, min, max);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(result)) throw new ValidationError("invalid_control_character", `${name} must be a single line without control characters`);
  return result;
}

export function integerValue(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new ValidationError("invalid_integer", `${name} must be an integer from ${min} through ${max}`);
  return Number(value);
}

export function identifier(value: unknown, name: string): string {
  const result = boundedString(value, name, 1, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new ValidationError("invalid_identifier", `${name} contains unsupported characters`);
  return result;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new ValidationError("invalid_enum", `${name} is invalid`);
  return value as T;
}

export function isAgentPhase(value: string): value is AgentPhase {
  return AGENT_PHASES.includes(value as AgentPhase);
}

export function isAssignmentKind(value: string): value is AssignmentKind {
  return ASSIGNMENT_KINDS.includes(value as AssignmentKind);
}
