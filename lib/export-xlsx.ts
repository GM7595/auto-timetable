import ExcelJS from "exceljs";
import type { TimetableExportData } from "./export-data";

const HEADER_ROW = 6;
const TIME_FORMAT = "[h]:mm";
const COLUMN_WIDTHS = [9.5, 11, 10, 28, 24, 34, 23, 38, 12];
const HEADERS = ["開始", "終了", "所要(分)", "内容", "出演者・グループ", "メンバー", "設備", "メモ", "時刻固定"];

// CJK characters need roughly twice the width of Latin characters in Excel's
// character-based column units. This sizes only populated rows, not the sheet.
function wrappedLines(value: string, width: number): number {
  return value.split(/\r\n|\r|\n/).reduce((total, line) => {
    const units = Array.from(line).reduce((sum, character) => sum + (character.codePointAt(0)! > 0xff ? 2 : 1), 0);
    return total + Math.max(1, Math.ceil(units / Math.max(1, width - 2)));
  }, 0);
}

/** Export the already-computed timetable snapshot entirely in the browser. */
export async function buildTimetableXlsx(data: TimetableExportData): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "タイテ作成ツール";
  workbook.title = data.event.name;
  const sheet = workbook.addWorksheet("タイムテーブル", {
    views: [{ state: "frozen", ySplit: HEADER_ROW, showGridLines: false, activeCell: "A7" }],
    properties: { defaultRowHeight: 21, tabColor: { argb: "FF444A68" } },
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
      margins: { left: .25, right: .25, top: .35, bottom: .35, header: .15, footer: .15 },
    },
  });
  sheet.columns = COLUMN_WIDTHS.map(width => ({ width }));

  sheet.getRow(1).height = 6;
  sheet.getCell("A2").value = data.event.name;
  sheet.getCell("A2").font = { name: "Arial", size: 14, bold: true, color: { argb: "FF242936" } };
  sheet.getRow(2).height = 26;
  sheet.getCell("A3").value = "開催日";
  sheet.getCell("B3").value = new Date(`${data.event.date}T00:00:00.000Z`);
  sheet.getCell("B3").numFmt = "yyyy/mm/dd";
  sheet.getCell("D3").value = "会場";
  sheet.getCell("E3").value = data.event.location === "" ? null : data.event.location;
  sheet.getCell("A4").value = "開始";
  sheet.getCell("B4").value = data.event.startTime / 1440;
  sheet.getCell("D4").value = "終了予定";
  sheet.getCell("E4").value = data.endsAt / 1440;
  sheet.getCell("G4").value = "会場終了";
  sheet.getCell("H4").value = data.event.endTime / 1440;
  for (const address of ["B4", "E4", "H4"]) sheet.getCell(address).numFmt = TIME_FORMAT;
  for (const rowNumber of [3, 4]) {
    sheet.getRow(rowNumber).eachCell(cell => {
      cell.font = { name: "Arial", size: 10, color: { argb: "FF444A59" } };
      cell.alignment = { vertical: "middle", horizontal: typeof cell.value === "number" || cell.value instanceof Date ? "right" : "left" };
    });
  }
  sheet.getRow(5).height = 7;

  const header = sheet.getRow(HEADER_ROW);
  header.values = HEADERS;
  header.height = 25;
  header.eachCell(cell => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF444A68" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { right: { style: "thin", color: { argb: "FFFFFFFF" } } };
  });

  for (const item of data.rows) {
    // ExcelJS treats plain strings as literal values, including text beginning
    // with =, +, - or @. Formula objects are deliberately never created here.
    // Genuine blanks also avoid empty shared-string interoperability issues.
    const values = [item.start / 1440, item.end / 1440, item.durationMinutes, item.title, item.group, item.members.join("\n"), item.equipment.join("\n"), item.notes, item.locked ? "固定" : ""].map(value => value === "" ? null : value);
    const row = sheet.addRow(values);
    const lines = Math.max(...values.map((value, index) => typeof value === "string" ? wrappedLines(value, COLUMN_WIDTHS[index]) : 1));
    row.height = Math.min(240, Math.max(23, lines * 13 + 8));
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cell.font = { name: "Arial", size: 10, color: { argb: item.kind === "program" ? "FF242936" : "FF58606F" } };
      cell.alignment = { vertical: "middle", horizontal: column <= 3 ? "right" : column === 9 ? "center" : "left", wrapText: column >= 4 };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE1E4EA" } } };
      if (item.kind !== "program") cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: item.kind === "changeover" ? "FFF0F2F6" : "FFFBF6E9" } };
      if (column <= 2) cell.numFmt = TIME_FORMAT;
      if (column === 3) cell.numFmt = "0";
    });
  }

  sheet.pageSetup.printArea = `A1:I${Math.max(HEADER_ROW, sheet.rowCount)}`;
  // Document-based writeBuffer is the supported ExcelJS browser API; no file,
  // server, network request or live event state is involved in generation.
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
