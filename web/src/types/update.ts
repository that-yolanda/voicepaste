/** Update state machine types. */

export type UpdateState =
  | "idle"
  | "checking"
  | "not-available"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error"
  | "disabled";

export interface UpdateProgress {
  total?: number;
  downloaded?: number;
}

export interface UpdateResult {
  available: boolean;
  version?: string;
  body?: string;
}
