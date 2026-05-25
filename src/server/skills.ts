interface AdapterSkillContext {
  agentId: string;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

interface AdapterSkillEntry {
  key: string;
  runtimeName: string | null;
  desired: boolean;
  managed: boolean;
  required?: boolean;
  requiredReason?: string | null;
  state: string;
  origin?: string;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

interface AdapterSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: string;
  desiredSkills: string[];
  entries: AdapterSkillEntry[];
  warnings: string[];
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return {
    adapterType: ctx.adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills: [],
    entries: [],
    warnings: [],
  };
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return listHermesSkills(ctx);
}
