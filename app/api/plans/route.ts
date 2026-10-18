import { z } from "zod";
import { proposePlans } from "@/lib/decisions";
import { checkBrowserOrigin, errorResponse, eventStateSchema, getPrivateCallerContext, jsonResponse, readJsonBody } from "@/lib/server-store";

const proposalSchema = z.object({
  state: eventStateSchema,
  text: z.string().trim().min(1).max(2000),
}).strict();

export async function POST(request: Request) {
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    const body = await readJsonBody(request, proposalSchema);
    return jsonResponse(await proposePlans(body.state, body.text));
  } catch (error) {
    return errorResponse(error);
  }
}
