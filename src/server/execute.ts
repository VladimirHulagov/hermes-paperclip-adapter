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

const DEFAULT_PROMPT_TEMPLATE = `Ты — "{{agentName}}", AI-агент в компании под управлением Paperclip.

Agent ID: {{agentId}}
Company ID: {{companyId}}

Ты работаешь в автоматическом режиме heartbeat. Каждый запуск — отдельный run. Между run контекст теряется, единственная связь — чеклист задачи (paperclip_set_checklist) и файлы на диске.

Действуй, не спрашивай разрешения. Если задача ясна — делай. Если есть план — выполняй. Если неясно — исследуй через инструменты.

## Инструменты Paperclip (MCP, префикс paperclip_)

- paperclip_list_issues / paperclip_get_issue / paperclip_create_issue / paperclip_update_issue / paperclip_delete_issue
- paperclip_checkout_issue / paperclip_release_issue
- paperclip_list_comments / paperclip_create_comment
- paperclip_set_checklist — установить чеклист задачи (массив {text, done}), заменяет полностью
- paperclip_list_agents / paperclip_get_agent / paperclip_get_current_agent
- paperclip_list_projects / paperclip_get_company / paperclip_list_goals

## Чеклист задачи

paperclip_set_checklist — способ сохранить план и прогресс между run. Чеклист виден в UI задачи.
1. После анализа задачи — вызови paperclip_set_checklist с планом шагов (все done=false)
2. После каждого выполненного шага — обновляй чеклист (done=true для выполненных)
3. Максимально 20 пунктов, текст до 200 символов

## Чеклист каждого run

1. Если taskId задан — главный приоритет
2. Если нет — paperclip_list_issues(status="todo,in_progress,blocked", assigneeAgentId="me")
3. Для in_progress — paperclip_get_issue, изучи чеклист, продолжай с первого невыполненного
4. Для todo — paperclip_checkout_issue, проанализируй, создай чеклист, оставь комментарий
5. Выполняй работу через инструменты
6. После каждого шага обновляй чеклист (paperclip_set_checklist с обновлённым done)
7. Публикуй результаты: paperclip_create_comment(issueId, отчёт)
8. Готово — paperclip_update_issue(issueId, status="done")
9. Заблокирован — paperclip_update_issue(issueId, status="blocked")

Run может быть прерван. Если что-то сделано — сразу paperclip_create_comment.

{{#taskId}}
## Назначенная задача

Issue ID: {{taskId}}
Заголовок: {{taskTitle}}

{{taskBody}}
{{/taskId}}

{{#noTask}}
## Пробуждение по heartbeat

1. paperclip_list_issues → найди свои задачи
2. Работай над задачей с наивысшим приоритетом
3. Нет задач → paperclip_create_comment со статусом
{{/noTask}}

{{#wakeReason}}
## Контекст пробуждения

Причина: {{wakeReason}}
{{#wakeCommentId}}
Сначала прочитай комментарий-триггер: paperclip_list_comments(issueId="{{taskId}}")
{{/wakeCommentId}}
{{/wakeReason}}`;

async function loadPromptTemplate(): Promise<string> {
  const candidates = [
    "/paperclip/prompt-template.md",
    "/run/prompt-template.md",
  ];
  for (const p of candidates) {
    try {
      const content = await readFile(p, "utf-8");
      if (content.trim()) return content;
    } catch {}
  }
  return DEFAULT_PROMPT_TEMPLATE;
}

let _cachedTemplate: string | null = null;
let _cachedTemplateMtime: number = 0;

async function getPromptTemplate(): Promise<string> {
  const p = "/paperclip/prompt-template.md";
  try {
    const stat = await (await import("node:fs/promises")).stat(p);
    if (stat.mtimeMs !== _cachedTemplateMtime) {
      _cachedTemplate = await readFile(p, "utf-8");
      _cachedTemplateMtime = stat.mtimeMs;
    }
    return _cachedTemplate || DEFAULT_PROMPT_TEMPLATE;
  } catch {
    return DEFAULT_PROMPT_TEMPLATE;
  }
}

function buildInputMessage(
  ctx: AdapterExecutionContext,
): string {
  const taskId = cfgString(ctx.context?.taskId) || cfgString(ctx.context?.issueId) || "";
  const taskTitle = cfgString(ctx.context?.taskTitle) || "";
  const taskBody = cfgString(ctx.context?.taskBody) || "";
  const wakeReason = cfgString(ctx.context?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Agent";

  if (taskId) {
    let msg = `[HEARTBEAT RUN] ${agentName} — задача назначена.\n\n`;
    msg += `Issue: ${taskTitle} (${taskId})\n`;
    if (taskBody) {
      msg += `\n${taskBody}\n`;
    }
    if (wakeReason) {
      msg += `\nПричина пробуждения: ${wakeReason}\n`;
    }
    msg += `\nДействуй: вызови инструменты, выполни работу, обнови чеклист, оставь комментарий с результатом. Не пиши планы — делай.`;
    return msg;
  }

  let msg = `[HEARTBEAT RUN] ${agentName} — heartbeat без конкретной задачи.\n\n`;
  msg += `1. Вызови paperclip_list_issues(status="todo,in_progress,blocked", assigneeAgentId="me")\n`;
  msg += `2. Выбери задачу с наивысшим приоритетом\n`;
  msg += `3. Для in_progress — продолжай с чеклиста\n`;
  msg += `4. Для todo — checkout, создай чеклист, начни работу\n`;
  msg += `5. Нет задач — оставь комментарий со статусом\n`;
  msg += `\nДействуй через инструменты. Не пиши планы — делай.`;
  if (wakeReason) {
    msg += `\n\nПричина пробуждения: ${wakeReason}`;
  }
  return msg;
}

async function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): Promise<string> {
  const template = cfgString(config.promptTemplate) || (await getPromptTemplate());

  const taskId = cfgString(ctx.context?.taskId) || cfgString(ctx.context?.issueId);
  const taskTitle = cfgString(ctx.context?.taskTitle) || "";
  const taskBody = cfgString(ctx.context?.taskBody) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";

  const wakeReason = cfgString(ctx.context?.wakeReason) || "";
  const wakeCommentId = cfgString(ctx.context?.wakeCommentId) || cfgString(ctx.context?.commentId) || "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle,
    taskBody,
    wakeReason,
    wakeCommentId,
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
  rendered = rendered.replace(
    /\{\{#wakeReason\}\}([\s\S]*?)\{\{\/wakeReason\}\}/g,
    wakeReason ? "$1" : "",
  );
  rendered = rendered.replace(
    /\{\{#wakeCommentId\}\}([\s\S]*?)\{\{\/wakeCommentId\}\}/g,
    wakeCommentId ? "$1" : "",
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

  const prompt = await buildPrompt(ctx, config);
  const inputMessage = buildInputMessage(ctx);
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
        input: inputMessage,
        instructions: prompt,
        session_id: sessionId || `paperclip-${agentId}`,
        paperclip_api_key: ctx.authToken || undefined,
        heartbeat_run_id: ctx.runId || undefined,
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
          if (finalOutput === "(empty)") finalOutput = "";
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
