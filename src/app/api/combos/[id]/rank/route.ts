import { NextResponse } from "next/server";
import { getComboById } from "@/lib/db/combos";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { comboErrorResponse } from "@/lib/api/comboErrorResponse";
import { rankModelBySpeed } from "@omniroute/open-sse/services/rankedAutobalanceScheduler";

type RankedConfig = { rankedAutobalance?: { autoRank?: boolean; sourceModelId?: string } };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(
    request as unknown as Parameters<typeof requireManagementAuth>[0]
  );
  if (authError) return authError;
  const { id } = await params;
  const combo = (await getComboById(id)) as (Record<string, unknown> & { config?: unknown }) | null;
  if (!combo)
    return comboErrorResponse(
      "COMBO_007",
      404,
      { id },
      request as unknown as Parameters<typeof comboErrorResponse>[3]
    );
  const cfg = combo.config as RankedConfig | null;
  const sourceModelId =
    (cfg as unknown as { rankedAutobalance?: { sourceModelId?: string } })?.rankedAutobalance
      ?.sourceModelId ?? (combo.name as string);
  // Allow ranking even if autoRank false (manual trigger)
  const result = rankModelBySpeed(String(sourceModelId));
  return NextResponse.json({ success: true, comboId: id, sourceModelId, ...result });
}
