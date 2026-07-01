import assert from "node:assert/strict";
import test from "node:test";
import {
  LAYER_DELIMITER,
  addColumn,
  addRow,
  columnName,
  createCell,
  createSheet,
  decodeLayerBundle,
  encodeLayerBundle,
  exportSheetToCsv,
  getDimensions,
  importCsvToSheet,
  parseCsv,
  removeColumn,
  removeRow,
  setCellLayer,
  stringifyCsv
} from "../src/sheet-model.js";

test("parseCsv handles commas, quotes, CRLF, and embedded newlines", () => {
  const input = '"a,b","quote ""inside"""\r\n"line\nbreak",tail,';
  assert.deepEqual(parseCsv(input), [
    ["a,b", 'quote "inside"'],
    ["line\nbreak", "tail", ""]
  ]);
});

test("stringifyCsv round-trips irregular CSV fields", () => {
  const rows = [
    ["plain", "comma,inside", 'quote "inside"'],
    ["multi\nline", "", "last"]
  ];
  assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
});

test("plain CSV imports into base value layer and pads ragged rows", () => {
  const sheet = importCsvToSheet("A,B\nC");
  assert.deepEqual(getDimensions(sheet), { rowCount: 2, columnCount: 2 });
  assert.equal(sheet.rows[0][0].value, "A");
  assert.equal(sheet.rows[0][0].procedure, "");
  assert.equal(sheet.rows[1][1].value, "");
});

test("layer bundle encodes exactly four ontology layers in one CSV cell", () => {
  const cell = createCell({
    value: "Revenue, KR",
    procedure: "sum(x) / count(y)",
    period: "P1M",
    source: "https://example.test/report.csv"
  });

  const bundle = encodeLayerBundle(cell);
  assert.equal(bundle.split(LAYER_DELIMITER).length, 4);
  assert.deepEqual(decodeLayerBundle(bundle), cell);
});

test("layer bundle survives delimiter, backslash, commas, quotes, and newlines", () => {
  const cell = createCell({
    value: `A${LAYER_DELIMITER}B`,
    procedure: "path\\to\\job",
    period: "2026-07\nP1M",
    source: 'doc "alpha", row 9'
  });

  const csv = stringifyCsv([[encodeLayerBundle(cell)]]);
  const imported = importCsvToSheet(csv);
  assert.deepEqual(imported.rows[0][0], cell);
});

test("external over-delimited bundles preserve the extra material in source", () => {
  const imported = decodeLayerBundle(["v", "p", "t", "s1", "s2"].join(LAYER_DELIMITER));
  assert.equal(imported.value, "v");
  assert.equal(imported.procedure, "p");
  assert.equal(imported.period, "t");
  assert.equal(imported.source, `s1${LAYER_DELIMITER}s2`);
});

test("exportSheetToCsv and importCsvToSheet round-trip full sheets", () => {
  let sheet = createSheet(2, 2);
  sheet = setCellLayer(sheet, 0, 0, "value", "A");
  sheet = setCellLayer(sheet, 0, 0, "procedure", "normalize(A)");
  sheet = setCellLayer(sheet, 0, 1, "period", "daily");
  sheet = setCellLayer(sheet, 1, 0, "source", "notebook.md#cell-4");

  const imported = importCsvToSheet(exportSheetToCsv(sheet));
  assert.deepEqual(imported, sheet);
});

test("addRow and addColumn keep a rectangular 3D table", () => {
  const sheet = addColumn(addRow(createSheet(1, 1)));
  assert.deepEqual(getDimensions(sheet), { rowCount: 2, columnCount: 2 });
  assert.deepEqual(sheet.rows[1][1], createCell());
});

test("removeRow and removeColumn shrink while preserving at least one cell", () => {
  const shrunk = removeColumn(removeRow(createSheet(3, 3)));
  assert.deepEqual(getDimensions(shrunk), { rowCount: 2, columnCount: 2 });

  const minimum = removeColumn(removeRow(createSheet(1, 1)));
  assert.deepEqual(getDimensions(minimum), { rowCount: 1, columnCount: 1 });
});

test("setCellLayer rejects bad layer names and out-of-range cells", () => {
  assert.throws(() => setCellLayer(createSheet(), 0, 0, "bad", "x"), /Unknown layer/);
  assert.throws(() => setCellLayer(createSheet(1, 1), 2, 0, "value", "x"), /does not exist/);
});

test("columnName supports spreadsheet-style labels beyond Z", () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(701), "ZZ");
  assert.equal(columnName(702), "AAA");
});
