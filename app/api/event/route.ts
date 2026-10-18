import { z } from "zod";
import { decisionsConfigured } from "@/lib/decisions";
import { checkBrowserOrigin, errorResponse, eventStateSchema, getEventState, getPrivateCallerContext, jsonResponse, readJsonBody, saveEventState } from "@/lib/server-store";

export async function GET() {
  try {
    await getPrivateCallerContext();
    return jsonResponse({ state: await getEventState(), storage: "cloud", aiConfigured: decisionsConfigured() });
  } catch (error) {
    return errorResponse(error);
  }
}

const updateSchema = z.object({
  state: eventStateSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export async function PUT(request: Request) {
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    const body = await readJsonBody(request, updateSchema);
    const result = await saveEventState(body.state, body.expectedRevision);
    if (result.conflict) return jsonResponse({ error: "別の画面で更新されました。最新の内容を読み込んで、もう一度お試しください。", code: "revision_conflict", state: result.state }, 409);
    return jsonResponse({ state: result.state, storage: "cloud", aiConfigured: decisionsConfigured() });
  } catch (error) {
    return errorResponse(error);
  }
}
