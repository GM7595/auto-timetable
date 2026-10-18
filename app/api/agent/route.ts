import { listAgentProposals, publishAgentProposal, publishProposalSchema } from "@/lib/agent-proposals";
import { checkBrowserOrigin, errorResponse, getEventState, getPrivateCallerContext, jsonResponse, readJsonBody } from "@/lib/server-store";

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

// The same proposal-only writer is available to authorized cloud services.
// Site service authentication and the owner-private audience remain required;
// this route never updates the actual event and accepts no caller-supplied plan.
export async function POST(request: Request) {
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    const body = await readJsonBody(request, publishProposalSchema, 32 * 1024);
    return jsonResponse(await publishAgentProposal(body));
  } catch (error) {
    return errorResponse(error);
  }
}
