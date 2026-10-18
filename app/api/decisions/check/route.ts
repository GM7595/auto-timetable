import { checkDecisionsConnection } from "@/lib/decisions";
import { checkBrowserOrigin, errorResponse, getPrivateCallerContext, jsonResponse } from "@/lib/server-store";

export async function POST(request: Request) {
  try {
    checkBrowserOrigin(request);
    await getPrivateCallerContext();
    // Small synthetic choices verify authentication without sending event data.
    return jsonResponse(await checkDecisionsConnection());
  } catch (error) {
    return errorResponse(error);
  }
}
