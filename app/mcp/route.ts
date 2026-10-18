import { z } from "zod";
import { proposePlans } from "@/lib/decisions";
import { getAgentContext, publishAgentProposal } from "@/lib/agent-proposals";
import { listPendingChangeRequests } from "@/lib/change-requests";
import { listMcpEvents, McpEventError, subscribeMcpEvent, unsubscribeMcpEvent } from "@/lib/mcp-events";
import { computeSchedule } from "@/lib/planner";
import { createProposalReviewUrl } from "@/lib/proposal-review-link";
import { checkBrowserOrigin, getEventState, getPrivateCallerContext, HttpError, jsonResponse, readJsonBody } from "@/lib/server-store";

const toolDefinitions = [
  {
    name: "get_event",
    description: "タイテ作成ツールに保存されたイベント、現在の進行表、未解決の制約を読み取ります。変更は行いません。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_open_issues",
    description: "現在の進行表の時間・出演条件の制約違反と注意点を確認します。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "propose_change",
    description: "進行上の変更を日本語で伝え、保存済みイベントに対する成立する変更案を比較します。提案のみで、進行表には適用しません。例：全体が10分押しています。",
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2000, description: "変更対象と時刻・分数がわかる依頼" } }, required: ["text"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_agent_context",
    description: "保存済みイベントとrevision、現在の進行表、最近の変更履歴、公開済み提案、提案のみという操作範囲を読み取ります。dotsを含む認可済みエージェント用です。呼出元がdotsであることは検証しません。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "publish_change_proposal",
    description: "最新のget_agent_contextのrevisionに対して変更案を作り、主催者の確認用に保存します。進行表への自動適用はしません。同じ内容の再試行には同じrequestIdを使います。内容やrevisionを変える時は新しいrequestIdを使ってください。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2000, description: "変更対象と時刻・分数がわかる依頼" },
        expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1, description: "直前に読み取ったイベントのrevision" },
        requestId: { type: "string", minLength: 1, maxLength: 120, description: "イベント内で一意な再試行用ID" },
      },
      required: ["text", "expectedRevision", "requestId"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(200), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
}).strict();

const emptyArguments = z.object({}).strict();
const changeArguments = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
const toolCallSchema = z.object({ name: z.string().min(1).max(100), arguments: z.unknown().optional(), _meta: z.unknown().optional() }).strict();

function rpcResult(id: string | number | null, result: unknown) {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

function content(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

async function runTool(name: string, args: unknown, origin: string) {
  if (name === "get_event") {
    emptyArguments.parse(args ?? {});
    const state = await getEventState();
    return { state, schedule: computeSchedule(state), storage: "cloud", pendingChangeRequests: await listPendingChangeRequests(state.event.id) };
  }
  if (name === "list_open_issues") {
    emptyArguments.parse(args ?? {});
    const state = await getEventState();
    const schedule = computeSchedule(state);
    return { revision: state.revision, issues: schedule.violations, bufferMinutes: schedule.bufferMinutes };
  }
  if (name === "propose_change") {
    const parsed = changeArguments.parse(args);
    const state = await getEventState();
    return {
      ...await proposePlans(state, parsed.text),
      revision: state.revision,
      applied: false,
      reviewUrl: createProposalReviewUrl(origin, { eventId: state.event.id, revision: state.revision, text: parsed.text }),
      reviewNotice: "このリンクは保存済み提案ではなく、開いた時点の最新条件で変更案を再比較するためのものです。進行表への反映には主催者の承認が必要です。",
    };
  }
  if (name === "get_agent_context") {
    emptyArguments.parse(args ?? {});
    return getAgentContext();
  }
  if (name === "publish_change_proposal") return publishAgentProposal(args);
  throw new HttpError(404, "そのツールはありません。", "unknown_tool");
}

export async function POST(request: Request) {
  let id: string | number | null = null;
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    const rpc = await readJsonBody(request, rpcSchema, 32 * 1024);
    id = rpc.id ?? null;
    if (rpc.id === undefined) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    if (rpc.method === "server/discover") return rpcResult(id, { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} }, serverInfo: { name: "cue", version: "1.0.0" } });
    if (rpc.method.startsWith("events/")) {
      try {
        if (rpc.method === "events/list") return rpcResult(id, await listMcpEvents(rpc.params));
        const principal = request.headers.get("oai-authenticated-user-id");
        if (rpc.method === "events/subscribe") return rpcResult(id, await subscribeMcpEvent(principal, rpc.params));
        if (rpc.method === "events/unsubscribe") return rpcResult(id, await unsubscribeMcpEvent(principal, rpc.params));
        return rpcError(id, -32601, "Method not found");
      } catch (error) {
        if (error instanceof McpEventError) return rpcError(id, error.rpcCode, error.message, error.reason ? { reason: error.reason } : undefined);
        if (error instanceof z.ZodError) return rpcError(id, -32602, "イベント購読の入力内容を確認してください。");
        return rpcError(id, -32603, "イベント購読を処理できませんでした。");
      }
    }
    if (rpc.method === "tools/list") return rpcResult(id, { tools: toolDefinitions });
    if (rpc.method !== "tools/call") return rpcError(id, -32601, "Method not found");
    const params = toolCallSchema.safeParse(rpc.params);
    if (!params.success) return rpcError(id, -32602, "Invalid tool parameters");
    try {
      return rpcResult(id, content(await runTool(params.data.name, params.data.arguments, new URL(request.url).origin)));
    } catch (error) {
      const message = error instanceof HttpError ? error.message : error instanceof z.ZodError ? "ツールの入力内容を確認してください。" : "ツールを実行できませんでした。少し待って再度お試しください。";
      return rpcResult(id, content({ error: message, ...(error instanceof HttpError ? { code: error.code } : {}) }, true));
    }
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Invalid request";
    if (error instanceof HttpError && (error.status === 403 || error.status === 413 || error.status === 415)) {
      return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32600, message } }, error.status);
    }
    return rpcError(id, error instanceof HttpError && error.code === "invalid_json" ? -32700 : -32600, message);
  }
}

export async function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
