import { listAgentProposals } from "@/lib/agent-proposals";
import { errorResponse, getEventState, getPrivateCallerContext, jsonResponse } from "@/lib/server-store";

export async function GET() {
  try {
    await getPrivateCallerContext();
    const state = await getEventState();
    const proposals = await listAgentProposals(state.event.id);
    return jsonResponse({ proposals, ...(proposals[0] ? { latestContactAt: proposals[0].createdAt } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}
