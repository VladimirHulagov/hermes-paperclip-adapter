import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

import { renderTemplate } from "@paperclipai/adapter-utils/server-utils";

import {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MODEL,
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

## CRITICAL RULES — YOU MUST FOLLOW THESE EXACTLY

Your conversation is managed by an automated system. When you respond with plain text (no tool calls), the system treats your response as FINAL and ENDS the run immediately. Your text is NOT posted anywhere — it is discarded.

**Therefore: EVERY response you produce MUST include at least one tool call.** Never produce a text-only response.

The correct pattern is:
1. Gather information using tools (paperclip_list_issues, paperclip_get_issue, paperclip_list_comments, web_search, etc.)
2. When ready to deliver, call \`paperclip_create_comment(issueId, yourReport)\` to post your work
3. Then call \`paperclip_update_issue(issueId, status="done")\` to mark the task complete
4. Only AFTER both calls succeed may you produce a final text summary

**WRONG** (this will end the run and lose all your work):
- "Now let me post the report." → text-only response, run ends, nothing posted
- "I will now write the deliverable." → text-only response, run ends, nothing posted

**RIGHT** (this posts your work):
- Call paperclip_create_comment(issueId, "Full report text here...")
- Then call paperclip_update_issue(issueId, status="done")

NEVER say "let me..." or "now I will..." without immediately making a tool call in the same response.

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. Post your deliverable as a comment using \`paperclip_create_comment("{{taskId}}", body)\` — this is MANDATORY
3. Update the issue status to done using \`paperclip_update_issue("{{taskId}}", status="done")\`
{{/taskId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List issues assigned to you using paperclip_list_issues
2. If issues found, pick the highest priority one and work on it
3. If no issues found, check for any unassigned issues
4. If truly nothing to do, post a brief status comment if any issue is in progress.
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

function formatEventLog(event: Record<string, unknown>): string {
  const type = event.event as string;
  switch (type) {
    case "reasoning.available":
      return `[thinking] ${(event.text as string || "").slice(0, 500)}`;
    case "tool.started":
      return `[tool] ${(event.tool as string || "unknown")} — ${(event.preview as string || "").slice(0, 200)}`;
    case "tool.completed": {
      const dur = typeof event.duration === "number" ? ` (${event.duration}s)` : "";
      const err = event.error ? " [ERROR]" : "";
      return `[done] ${(event.tool as string || "unknown")}${dur}${err}`;
    }
    case "message.delta":
      return (event.delta as string) || "";
    case "run.completed":
      return `[completed] Agent finished`;
    case "run.failed":
      return `[error] Agent failed: ${event.error || "unknown"}`;
    default:
      return `[${type}] ${JSON.stringify(event).slice(0, 300)}`;
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
  const baseUrl = `http://hermes-gateway:${port}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${GATEWAY_API_KEY}`,
  };
  if (sessionId) {
    headers["X-Hermes-Session-Id"] = sessionId;
  }

  await ctx.onLog(
    "stdout",
    `[hermes] Starting run on gateway port ${port} (timeout=${timeoutSec}s)\n`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const startResp = await fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: "Work on the assigned task",
        instructions: prompt,
        session_id: sessionId || `paperclip-${agentId}`,
        paperclip_api_key: ctx.authToken || undefined,
      }),
      signal: controller.signal,
    });

    if (!startResp.ok) {
      clearTimeout(timeout);
      const errorBody = await startResp.text();
      await ctx.onLog(
        "stderr",
        `[hermes] Gateway start run returned ${startResp.status}: ${errorBody}\n`,
      );
      return {
        exitCode: 1,
        signal: null,
        errorMessage: `Gateway HTTP ${startResp.status}: ${errorBody.slice(0, 500)}`,
        provider: null,
        model,
        timedOut: false,
      };
    }

    const startData = (await startResp.json()) as { run_id: string; status: string };
    const runId = startData.run_id;

    await ctx.onLog("stdout", `[hermes] Run ${runId} started, streaming events...\n`);

    const eventsResp = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
      signal: controller.signal,
    });

    if (!eventsResp.ok) {
      clearTimeout(timeout);
      const errorBody = await eventsResp.text();
      await ctx.onLog(
        "stderr",
        `[hermes] Gateway events stream returned ${eventsResp.status}: ${errorBody}\n`,
      );
      return {
        exitCode: 1,
        signal: null,
        errorMessage: `Events HTTP ${eventsResp.status}: ${errorBody.slice(0, 500)}`,
        provider: null,
        model,
        timedOut: false,
      };
    }

    let finalOutput = "";
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
    let failed = false;
    let errorMessage = "";

    const reader = eventsResp.body?.getReader();
    if (!reader) {
      clearTimeout(timeout);
      return {
        exitCode: 1,
        signal: null,
        errorMessage: "No readable stream from events endpoint",
        provider: null,
        model,
        timedOut: false,
      };
    }

    const decoder = new TextDecoder();
    let sseBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";

      let logBuffer = "";

      for (const line of lines) {
        if (line.startsWith(": ")) continue;
        if (!line.startsWith("data: ")) continue;

        const payload = line.slice(6).trim();
        if (!payload) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        const eventType = event.event as string;

        if (eventType === "message.delta") {
          logBuffer += event.delta as string || "";
          continue;
        }

        if (logBuffer) {
          await ctx.onLog("stdout", logBuffer);
          logBuffer = "";
        }

        if (eventType === "reasoning.available") {
          await ctx.onLog("stdout", `\n💭 ${(event.text as string || "").slice(0, 1000)}\n`);
        } else if (eventType === "tool.started") {
          await ctx.onLog("stdout", `\n🔧 ${(event.tool as string || "unknown")}${event.preview ? `: ${(event.preview as string).slice(0, 300)}` : ""}\n`);
        } else if (eventType === "tool.completed") {
          const dur = typeof event.duration === "number" ? ` (${event.duration.toFixed(1)}s)` : "";
          const err = event.error ? " ⚠️" : "";
          await ctx.onLog("stdout", `  ✓ ${(event.tool as string || "unknown")}${dur}${err}\n`);
        } else if (eventType === "run.completed") {
          finalOutput = (event.output as string) || "";
          usage = (event.usage as typeof usage) || null;
          await ctx.onLog("stdout", `\n[hermes] Run completed (${finalOutput.length} chars)\n`);
        } else if (eventType === "run.failed") {
          failed = true;
          errorMessage = (event.error as string) || "Unknown error";
          await ctx.onLog("stderr", `\n[hermes] Run failed: ${errorMessage}\n`);
        }
      }

      if (logBuffer) {
        await ctx.onLog("stdout", logBuffer);
      }
    }

    clearTimeout(timeout);

    if (failed) {
      return {
        exitCode: 1,
        signal: null,
        errorMessage: errorMessage.slice(0, 1000),
        provider: null,
        model,
        timedOut: false,
      };
    }

    const result: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      summary: finalOutput.slice(0, 2000),
      resultJson: finalOutput ? { summary: finalOutput.slice(0, 5000) } : null,
      provider: null,
      model,
      timedOut: false,
    };

    if (usage) {
      result.usage = {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      };
    }

    if (sessionId) {
      result.sessionParams = { sessionId };
      result.sessionDisplayId = sessionId.slice(0, 16);
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
