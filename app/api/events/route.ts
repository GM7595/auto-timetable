import { z } from "zod";
import { decisionsConfigured } from "@/lib/decisions";
import { checkBrowserOrigin, errorResponse, getPrivateCallerContext, jsonResponse, listEvents, readJsonBody, switchEventState } from "@/lib/server-store";

export async function GET(request: Request) {
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    return jsonResponse({ events: await listEvents() });
  } catch (error) {
    return errorResponse(error);
  }
}

const switchSchema = z.object({
  eventId: z.string().min(1).max(120),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export async function POST(request: Request) {
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    const body = await readJsonBody(request, switchSchema, 4096);
    const result = await switchEventState(body.eventId, body.expectedRevision);
    if (result.conflict) return jsonResponse({ error: "別の画面で更新されました。最新の内容を読み込んで、もう一度お試しください。", code: "revision_conflict", state: result.state }, 409);
    return jsonResponse({ state: result.state, storage: "cloud", aiConfigured: decisionsConfigured() });
  } catch (error) {
    return errorResponse(error);
  }
}
