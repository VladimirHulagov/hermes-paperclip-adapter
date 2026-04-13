/**
 * Server-side adapter module exports.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MODEL } from "../shared/constants.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

const HERMES_SHARED_CONFIG = "/opt/hermes-shared-config/config.yaml";

export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  try {
    const raw = await readFile(HERMES_SHARED_CONFIG, "utf-8");
    let model: string | undefined;
    let provider: string | undefined;
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*default:\s*(.+)$/);
      if (m && !model) model = m[1].trim();
      const p = line.match(/^\s+provider:\s*(.+)$/);
      if (p && !provider) provider = p[1].trim();
    }
    if (model) {
      return {
        model,
        provider: provider || "auto",
        source: HERMES_SHARED_CONFIG,
        candidates: [],
      };
    }
  } catch {
    // config.yaml not readable — fall through
  }
  return {
    model: DEFAULT_MODEL,
    provider: "zai",
    source: "fallback (config.yaml not found)",
  };
}

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for structured validation and migration of session parameters.
 *
 * Hermes Agent uses a single `sessionId` for cross-heartbeat session continuity
 * via the `--resume` CLI flag. The codec validates and normalizes this field.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
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
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
