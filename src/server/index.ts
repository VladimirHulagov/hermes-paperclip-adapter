import { DEFAULT_MODEL } from "../shared/constants.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listHermesModels } from "./models.js";

export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  return {
    model: DEFAULT_MODEL,
    provider: "zai",
    source: "gateway profile (static)",
    candidates: [],
  };
}

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id)
    );
  },
};

export { listHermesSkills as listSkills, syncHermesSkills as syncSkills } from "./skills.js";
