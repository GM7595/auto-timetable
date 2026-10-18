import { jsPDF } from "jspdf";
import { autoTable, type RowInput } from "jspdf-autotable";
import type { TimetableExportData } from "./export-data";

const FONT_URL = "/fonts/NotoSansJP-Regular.ttf";
const FONT_FILE = "NotoSansJP-Regular.ttf";
const FONT_NAME = "NotoSansJP";
const MARGIN = 14;
const BODY_FONT_SIZE = 9.5;
let fontRequest: Promise<Uint8Array> | undefined;

function isTrueType(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0;
}

async function loadFont(): Promise<Uint8Array> {
  if (!fontRequest) {
    fontRequest = fetch(FONT_URL, { credentials: "same-origin" }).then(async response => {
      if (!response.ok) throw new Error("PDF用の日本語フォントを読み込めませんでした。もう一度お試しください。");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!isTrueType(bytes)) throw new Error("PDF用の日本語フォントが正しく読み込まれませんでした。");
      return bytes;
    }).catch(error => {
      fontRequest = undefined;
      throw error;
    });
  }
  return fontRequest;
}

function binaryString(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return chunks.join("");
}

function time(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function dateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : date;
}

function content(row: TimetableExportData["rows"][number]): string {
  const lines = [row.title + (row.locked && row.kind === "program" ? "（時刻固定）" : "")];
  if (row.group && row.group !== row.title) lines.push(row.group);
  if (row.members.length) lines.push(`メンバー: ${row.members.join(" / ")}`);
  if (row.equipment.length) lines.push(`機材: ${row.equipment.join(" / ")}`);
  if (row.notes) lines.push(`メモ: ${row.notes}`);
  return lines.join("\n");
}

/** Build a local, searchable Japanese PDF; only the self-hosted font is fetched. */
export async function buildTimetablePdf(data: TimetableExportData, fontBytes?: Uint8Array): Promise<Uint8Array> {
  const bytes = fontBytes ?? await loadFont();
  if (!isTrueType(bytes)) throw new Error("PDF用の日本語フォントが正しく読み込まれませんでした。");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", putOnlyUsedFonts: true, compress: true });
  doc.addFileToVFS(FONT_FILE, binaryString(bytes));
  doc.addFont(FONT_FILE, FONT_NAME, "normal");
  doc.setFont(FONT_NAME, "normal");
  // jsPDF reports some font parsing errors without throwing. Do not download a
  // superficially successful document that silently lost its Japanese glyphs.
  const metadata = doc.getFont().metadata as { Unicode?: unknown };
  if (!metadata?.Unicode) throw new Error("PDF用の日本語フォントを使用できませんでした。");
  doc.setProperties({ title: `${data.event.name} - タイムテーブル`, subject: "イベント進行表", creator: "タイテ作成ツール" });
  doc.setLineHeightFactor(1.35);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const tableWidth = pageWidth - MARGIN * 2;

  doc.setFontSize(9);
  doc.setTextColor(100, 103, 106);
  doc.text("タイムテーブル", MARGIN, MARGIN + 1);
  doc.setFontSize(16);
  doc.setTextColor(35, 39, 43);
  const titleLines = doc.splitTextToSize(data.event.name, tableWidth) as string[];
  const titleY = MARGIN + 9;
  doc.text(titleLines, MARGIN, titleY);
  let headerY = titleY + Math.max(1, titleLines.length) * 7.6;
  doc.setFontSize(BODY_FONT_SIZE);
  doc.setTextColor(78, 81, 84);
  const details = [
    `${dateLabel(data.event.date)} / ${time(data.event.startTime)} - ${time(data.event.endTime)}（日本時間）`,
    ...(data.event.location ? [`会場: ${data.event.location}`] : []),
    `終了予定: ${time(data.endsAt)}`,
  ];
  for (const detail of details) {
    const lines = doc.splitTextToSize(detail, tableWidth) as string[];
    doc.text(lines, MARGIN, headerY);
    headerY += Math.max(1, lines.length) * 4.6;
  }

  doc.setFontSize(9);
  const continuationLines = doc.splitTextToSize(data.event.name, tableWidth) as string[];
  const continuationTop = MARGIN + Math.max(1, continuationLines.length) * 4.3 + 4;
  const rows: RowInput[] = data.rows.length
    ? data.rows.map(row => [
      `${time(row.start)} - ${time(row.end)}`,
      `${row.durationMinutes}分`,
      content(row),
    ])
    : [["", "", "進行枠はまだ登録されていません。"]];

  autoTable(doc, {
    head: [["時間", "所要", "内容"]],
    body: rows,
    startY: headerY + 4,
    margin: { top: continuationTop, left: MARGIN, right: MARGIN, bottom: 18 },
    tableWidth,
    theme: "grid",
    showHead: "everyPage",
    rowPageBreak: "avoid",
    styles: {
      font: FONT_NAME, fontStyle: "normal", fontSize: BODY_FONT_SIZE,
      cellPadding: { top: 2.7, right: 2.7, bottom: 2.7, left: 2.7 },
      overflow: "linebreak", valign: "top", textColor: [40, 44, 48],
      lineColor: [213, 213, 207], lineWidth: 0.15,
    },
    headStyles: { font: FONT_NAME, fontStyle: "normal", fillColor: [237, 238, 232], textColor: [55, 59, 62] },
    columnStyles: { 0: { cellWidth: 36 }, 1: { cellWidth: 17 }, 2: { cellWidth: tableWidth - 53 } },
    didParseCell(hook) {
      if (hook.section !== "body") return;
      const row = data.rows[hook.row.index];
      if (row && row.kind !== "program") {
        hook.cell.styles.fillColor = row.kind === "wait" ? [246, 245, 238] : [246, 247, 245];
        hook.cell.styles.textColor = [93, 96, 98];
      }
    },
    willDrawPage(hook) {
      if (hook.pageNumber <= 1) return;
      doc.setFont(FONT_NAME, "normal");
      doc.setFontSize(9);
      doc.setTextColor(95, 98, 101);
      doc.text(continuationLines, MARGIN, MARGIN + 1);
    },
  });

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont(FONT_NAME, "normal");
    doc.setFontSize(9);
    doc.setTextColor(105, 108, 110);
    doc.setDrawColor(213, 213, 207);
    doc.setLineWidth(0.15);
    doc.line(MARGIN, pageHeight - 13, pageWidth - MARGIN, pageHeight - 13);
    doc.text("タイテ作成ツール / 日本時間", MARGIN, pageHeight - 8);
    doc.text(`${page} / ${pages}`, pageWidth - MARGIN, pageHeight - 8, { align: "right" });
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
