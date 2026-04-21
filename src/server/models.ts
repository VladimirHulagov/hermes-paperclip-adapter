import { DEFAULT_MODEL } from "../shared/constants.js";

interface DiscoveredModel {
  id: string;
  label: string;
}

const CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: DiscoveredModel[] } | null = null;

function dedupe(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const m of models) {
    const id = m.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: m.label.trim() || id });
  }
  return out;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOllamaModels(): Promise<DiscoveredModel[]> {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim();
  if (!baseUrl) return [];
  const data = await fetchJson(`${baseUrl.replace(/\/+$/, "")}/api/tags`);
  if (!data || typeof data !== "object") return [];
  const models = Array.isArray((data as any).models) ? (data as any).models : [];
  return models
    .filter((m: any) => typeof m?.name === "string")
    .map((m: any) => ({ id: m.name, label: m.name }));
}

async function fetchOpenRouterModels(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return [];
  const data = await fetchJson("https://openrouter.ai/api/v1/models", {
    Authorization: `Bearer ${apiKey}`,
  });
  if (!data || typeof data !== "object") return [];
  const models = Array.isArray((data as any).data) ? (data as any).data : [];
  return models
    .filter((m: any) => typeof m?.id === "string")
    .map((m: any) => ({ id: m.id, label: m.name || m.id }));
}

async function fetchOpenAiModels(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return [];
  const data = await fetchJson("https://api.openai.com/v1/models", {
    Authorization: `Bearer ${apiKey}`,
  });
  if (!data || typeof data !== "object") return [];
  const models = Array.isArray((data as any).data) ? (data as any).data : [];
  return models
    .filter((m: any) => typeof m?.id === "string")
    .map((m: any) => ({ id: `openai/${m.id}`, label: m.id }));
}

async function fetchAnthropicModels(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const payload = (await res.json()) as any;
    const models = Array.isArray(payload.data) ? payload.data : [];
    return models
      .filter((m: any) => typeof m?.id === "string")
      .map((m: any) => ({ id: `anthropic/${m.id}`, label: m.display_name || m.id }));
  } catch {
    return [];
  }
}

async function fetchGoogleModels(): Promise<DiscoveredModel[]> {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) return [];
  const data = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );
  if (!data || typeof data !== "object") return [];
  const models = Array.isArray((data as any).models) ? (data as any).models : [];
  return models
    .filter((m: any) => typeof m?.name === "string")
    .map((m: any) => {
      const id = m.name.replace(/^models\//, "");
      return { id: `google/${id}`, label: m.displayName || id };
    });
}

async function discoverAll(): Promise<DiscoveredModel[]> {
  const results = await Promise.all([
    fetchOllamaModels(),
    fetchOpenRouterModels(),
    fetchOpenAiModels(),
    fetchAnthropicModels(),
    fetchGoogleModels(),
  ]);
  const all = results.flat();
  return dedupe(all).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

export async function listHermesModels(): Promise<DiscoveredModel[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverAll();
  if (models.length > 0) {
    cached = { expiresAt: now + CACHE_TTL_MS, models };
    return models;
  }

  return [{ id: DEFAULT_MODEL, label: DEFAULT_MODEL }];
}

export function resetHermesModelsCacheForTests(): void {
  cached = null;
}
