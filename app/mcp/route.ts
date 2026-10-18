import { z } from "zod";
import { proposePlans } from "@/lib/decisions";
import { computeSchedule } from "@/lib/planner";
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

function rpcError(id: string | number | null, code: number, message: string) {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

function content(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

async function runTool(name: string, args: unknown) {
  if (name === "get_event") {
    emptyArguments.parse(args ?? {});
    const state = await getEventState();
    return { state, schedule: computeSchedule(state), storage: "cloud" };
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
    return { ...await proposePlans(state, parsed.text), revision: state.revision, applied: false };
  }
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
    if (rpc.method === "server/discover") return rpcResult(id, { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "cue", version: "1.0.0" } });
    if (rpc.method === "tools/list") return rpcResult(id, { tools: toolDefinitions });
    if (rpc.method !== "tools/call") return rpcError(id, -32601, "Method not found");
    const params = toolCallSchema.safeParse(rpc.params);
    if (!params.success) return rpcError(id, -32602, "Invalid tool parameters");
    try {
      return rpcResult(id, content(await runTool(params.data.name, params.data.arguments)));
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
