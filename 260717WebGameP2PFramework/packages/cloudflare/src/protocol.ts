import {
  safeDecodeClientMessage,
  type ClientMessage,
  type ProtocolValidationOptions,
  type ValidationIssue,
} from "@relayplay/core";
import { RoomEngineError } from "@relayplay/server";

export { safeDecodeClientMessage } from "@relayplay/core";

function describeIssue(issue: ValidationIssue | undefined): string {
  return issue === undefined
    ? "client message failed protocol validation"
    : `${issue.path}: ${issue.message}`;
}

/** Converts core's non-throwing trust-boundary decoder into a room error. */
export function parseRoomCommand(
  encoded: string,
  options: ProtocolValidationOptions,
): ClientMessage {
  const result = safeDecodeClientMessage(encoded, options);
  if (result.success) {
    return result.data;
  }
  const tooLarge = result.issues.some((issue) => issue.code === "too_large");
  throw new RoomEngineError(
    tooLarge ? "MESSAGE_TOO_LARGE" : "INVALID_MESSAGE",
    describeIssue(result.issues[0]),
  );
}
