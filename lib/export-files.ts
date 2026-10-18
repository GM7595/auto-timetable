import { createTimetableExport } from "./export-data";
import type { EventState } from "./types";

export type DocumentExportFormat = "pdf" | "xlsx";

export async function createDocumentExport(state: EventState, format: DocumentExportFormat): Promise<Blob> {
  const data = createTimetableExport(state);
  const bytes = format === "pdf"
    ? await (await import("./export-pdf")).buildTimetablePdf(data)
    : await (await import("./export-xlsx")).buildTimetableXlsx(data);
  // Copy into an ordinary ArrayBuffer accepted by browsers' Blob API.
  const buffer = new Uint8Array(bytes).buffer;
  return new Blob([buffer], { type: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
