import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

import { renderTemplate } from "@paperclipai/adapter-utils/server-utils";

import {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MODEL,
  GATEWAY_MODE,
  GATEWAY_PORTS_FILE,
  GATEWAY_API_KEY,
} from "../shared/constants.js";

import { readFile } from "node:fs/promises";

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

const DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}

You have MCP tools for Paperclip (prefixed \`paperclip_\`). Use them instead of curl for ALL Paperclip API interactions:
- paperclip_list_issues(status?, assigneeAgentId?, projectId?, parentId?)
- paperclip_get_issue(issueId) — accepts UUID or identifier like HWQAA-1
- paperclip_create_issue(title, description?, status?, priority?, assigneeAgentId?, projectId?, parentId?)
- paperclip_update_issue(issueId, status?, priority?, assigneeAgentId?, description?, comment?)
- paperclip_delete_issue(issueId)
- paperclip_checkout_issue(issueId, expectedStatuses?) — claim an issue for work
- paperclip_release_issue(issueId) — release your checkout
- paperclip_list_comments(issueId, limit?)
- paperclip_create_comment(issueId, body)
- paperclip_list_agents()
- paperclip_get_agent(agentId) — use "me" for yourself
- paperclip_get_current_agent()
- paperclip_create_agent_hire(name, adapterType, role?, title?, icon?, reportsTo?, capabilities?, adapterConfig?, runtimeConfig?, permissions?, desiredSkills?, sourceIssueIds?, metadata?)
- paperclip_list_approvals(status?)
- paperclip_get_approval(approvalId)
- paperclip_approve_approval(approvalId)
- paperclip_reject_approval(approvalId, reason?)
- paperclip_list_projects()
- paperclip_get_company()
- paperclip_list_goals()
- paperclip_get_goal(goalId)

You also have access to messaging tools. If you need to ask a human a clarifying question, use the send_message tool to send a message via Telegram. The user will reply and you will receive the answer automatically.

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, update the issue status to done using paperclip_update_issue
3. Report what you did
{{/taskId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List issues assigned to you using paperclip_list_issues
2. If issues found, pick the highest priority one and work on it
3. If no issues found, check for any unassigned issues
4. If truly nothing to do, report briefly.
{{/noTask}}`;

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  const taskId = cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(ctx.config?.taskBody) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle,
    taskBody,
  };

  let rendered = template;
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );
  return renderTemplate(rendered, vars);
}

interface PortMapping {
  [agentId: string]: number;
}

async function lookupGatewayPort(agentId: string): Promise<number | null> {
  try {
    const raw = await readFile(GATEWAY_PORTS_FILE, "utf-8");
    const ports: PortMapping = JSON.parse(raw);
    return ports[agentId] ?? null;
  } catch {
    return null;
  }
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const agentId = cfgString(ctx.agent?.id) || "";

  if (!agentId) {
    return {
      exitCode: 1,
      signal: null,
      errorMessage: "No agent ID provided",
      provider: null,
      model: DEFAULT_MODEL,
      timedOut: false,
    };
  }

  const port = await lookupGatewayPort(agentId);

  if (!port) {
    await ctx.onLog(
      "stderr",
      `[hermes] No gateway port found for agent ${agentId}. Gateway may not be provisioned yet.\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      errorMessage: `Gateway not provisioned for agent ${agentId}`,
      provider: null,
      model: DEFAULT_MODEL,
      timedOut: false,
    };
  }

  const prompt = buildPrompt(ctx, config);
  const sessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  const model = cfgString(config.model) || DEFAULT_MODEL;

  await ctx.onLog(
    "stdout",
    `[hermes] Sending task to gateway on port ${port} (timeout=${timeoutSec}s)\n`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const response = await fetch(
      `http://hermes-gateway:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
          "X-Hermes-Session-Id": sessionId || `paperclip-${agentId}`,
        },
        body: JSON.stringify({
          model: "hermes-agent",
          stream: false,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: "Work on the assigned task" },
          ],
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorBody = await response.text();
      await ctx.onLog(
        "stderr",
        `[hermes] Gateway returned ${response.status}: ${errorBody}\n`,
      );
      return {
        exitCode: 1,
        signal: null,
        errorMessage: `Gateway HTTP ${response.status}: ${errorBody.slice(0, 500)}`,
        provider: null,
        model,
        timedOut: false,
      };
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const responseSessionId = response.headers.get("X-Hermes-Session-Id");
    const summary = data.choices?.[0]?.message?.content || "(No response)";
    const usage = data.usage;

    await ctx.onLog(
      "stdout",
      `[hermes] Gateway response received (${summary.length} chars)\n`,
    );
    if (responseSessionId) {
      await ctx.onLog("stdout", `[hermes] Session: ${responseSessionId}\n`);
    }

    const result: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      summary: summary.slice(0, 2000),
      provider: null,
      model,
      timedOut: false,
    };

    if (usage) {
      result.usage = {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
      };
    }

    if (responseSessionId) {
      result.sessionParams = { sessionId: responseSessionId };
      result.sessionDisplayId = responseSessionId.slice(0, 16);
    }

    return result;
  } catch (err: unknown) {
    clearTimeout(timeout);

    if (err instanceof DOMException && err.name === "AbortError") {
      await ctx.onLog(
        "stderr",
        `[hermes] Gateway request timed out after ${timeoutSec}s\n`,
      );
      return {
        exitCode: 1,
        signal: null,
        errorMessage: `Gateway request timed out after ${timeoutSec}s`,
        provider: null,
        model,
        timedOut: true,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog(
      "stderr",
      `[hermes] Gateway request failed: ${message}\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      errorMessage: `Gateway request failed: ${message}`,
      provider: null,
      model,
      timedOut: false,
    };
  }
}
