export type ErrorCode =
  | "FOUNDRY_NOT_FOUND"
  | "INPUT_ERROR"
  | "CONTRACT_AMBIGUOUS"
  | "FOUNDRY_ERROR"
  | "RUNTIME_ERROR";

export class UpgradoorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpgradoorError";
  }
}
