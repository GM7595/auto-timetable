import { decisionsConfigured } from "@/lib/decisions";
import { errorResponse, getPrivateCallerContext, jsonResponse } from "@/lib/server-store";

export async function GET() {
  try {
    await getPrivateCallerContext();
    return jsonResponse({
      decisionsConfigured: decisionsConfigured(),
      dotsConnected: false,
      mcpAvailable: true,
      protocolVersion: "2026-07-28",
      access: "owner-private",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
