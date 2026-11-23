import type { WireMessage } from "./protocol.ts";

/**
 * Describes what is wrong with a message a client reported, or returns `undefined` if nothing is.
 * Messages come from outside, so their fields cannot be trusted to have the types they claim.
 */
export function wireMessageProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "message is not an object";
  if (typeof value.id !== "string") return "message has no id";
  if (typeof value.type !== "string") return "message has no type";
  if (typeof value.text !== "string") return "message has no text";
  if (typeof value.time !== "number" || Number.isNaN(new Date(value.time).getTime())) {
    return "message has no valid time";
  }
  if (!isRoom(value.room)) return "message has no valid room";
  if (!isUser(value.sender)) return "message has no valid sender";
  if (value.hasMentions !== undefined && typeof value.hasMentions !== "boolean") {
    return "message has an invalid hasMentions";
  }
  if (value.mentions !== undefined && !isListOf(value.mentions, isUser)) {
    return "message has invalid mentions";
  }
  if (value.attachments !== undefined && !isListOf(value.attachments, isAttachment)) {
    return "message has invalid attachments";
  }
  if (value.quoted !== undefined && !isQuoted(value.quoted)) return "message has an invalid quoted";
  if (value.raw !== undefined && !isRecord(value.raw)) return "message has an invalid raw";
  return undefined;
}

/** Narrows a message that has passed `wireMessageProblem`. */
export function isWireMessage(value: unknown): value is WireMessage {
  return wireMessageProblem(value) === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isListOf(value: unknown, check: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}

/** `value[key]` is missing, or a value of the given type. */
function optional(value: Record<string, unknown>, key: string, type: string): boolean {
  return value[key] === undefined || typeof value[key] === type;
}

function isUser(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isRoom(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    optional(value, "name", "string") &&
    optional(value, "type", "string") &&
    optional(value, "isGroup", "boolean")
  );
}

function isAttachment(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    optional(value, "name", "string") &&
    optional(value, "mime", "string") &&
    optional(value, "size", "number")
  );
}

function isQuoted(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (value.sender === undefined || isUser(value.sender))
  );
}
