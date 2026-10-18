import { waitUntil } from "cloudflare:workers";
import { enqueueChangeRequest, enqueueChangeSchema, listChangeRequests } from "@/lib/change-requests";
import { dispatchChangeRequestEvent, getEventDeliveryStatus, prepareChangeRequestEvent } from "@/lib/mcp-events";
import { checkBrowserOrigin, errorResponse, getEventState, getPrivateCallerContext, jsonResponse, readJsonBody } from "@/lib/server-store";

export async function GET() {
  try {
    await getPrivateCallerContext();
    const state = await getEventState();
    return jsonResponse({ ...await listChangeRequests(state.event.id), events: await getEventDeliveryStatus(state.event.id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    const body = await readJsonBody(request, enqueueChangeSchema, 32 * 1024);
    const result = await enqueueChangeRequest(body);
    await prepareChangeRequestEvent(result.request);
    waitUntil(dispatchChangeRequestEvent(result.request).catch(() => { console.error("Event delivery could not be completed"); }));
    return jsonResponse({ ...result, ...await listChangeRequests(result.request.eventId), events: await getEventDeliveryStatus(result.request.eventId) });
  } catch (error) {
    return errorResponse(error);
  }
}
