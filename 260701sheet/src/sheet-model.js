export const LAYER_DELIMITER = "␟";

export const LAYERS = Object.freeze([
  { id: "value", label: "값" },
  { id: "procedure", label: "절차" },
  { id: "period", label: "주기" },
  { id: "source", label: "출처" }
]);

const LAYER_IDS = LAYERS.map((layer) => layer.id);

export function createCell(seed = {}) {
  return LAYER_IDS.reduce((cell, layerId) => {
    cell[layerId] = normalizeText(seed[layerId]);
    return cell;
  }, {});
}

export function createSheet(rowCount = 5, columnCount = 5) {
  const rows = Math.max(1, Number.parseInt(rowCount, 10) || 1);
  const columns = Math.max(1, Number.parseInt(columnCount, 10) || 1);

  return {
    rows: Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => createCell())
    )
  };
}

export function cloneSheet(sheet) {
  return {
    rows: sheet.rows.map((row) => row.map((cell) => createCell(cell)))
  };
}

export function getDimensions(sheet) {
  const rowCount = sheet.rows.length;
  const columnCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  return { rowCount, columnCount };
}

export function ensureRectangularRows(rows) {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0) || 1;
  const normalizedRows = (rows.length ? rows : [[]]).map((row) => {
    const normalizedRow = row.map((cell) => createCell(cell));
    while (normalizedRow.length < columnCount) {
      normalizedRow.push(createCell());
    }
    return normalizedRow;
  });

  return { rows: normalizedRows };
}

export function addRow(sheet) {
  const next = cloneSheet(sheet);
  const { columnCount } = getDimensions(next);
  next.rows.push(Array.from({ length: columnCount || 1 }, () => createCell()));
  return next;
}

export function addColumn(sheet) {
  const next = cloneSheet(sheet);
  next.rows.forEach((row) => row.push(createCell()));
  return next;
}

export function removeRow(sheet) {
  const next = cloneSheet(sheet);
  if (next.rows.length > 1) {
    next.rows.pop();
  }
  return next;
}

export function removeColumn(sheet) {
  const next = cloneSheet(sheet);
  const { columnCount } = getDimensions(next);
  if (columnCount <= 1) {
    return next;
  }

  next.rows.forEach((row) => row.pop());
  return next;
}

export function setCellLayer(sheet, rowIndex, columnIndex, layerId, value) {
  if (!LAYER_IDS.includes(layerId)) {
    throw new Error(`Unknown layer: ${layerId}`);
  }

  const next = cloneSheet(sheet);
  if (!next.rows[rowIndex] || !next.rows[rowIndex][columnIndex]) {
    throw new RangeError(`Cell ${rowIndex},${columnIndex} does not exist`);
  }

  next.rows[rowIndex][columnIndex][layerId] = normalizeText(value);
  return next;
}

export function parseCsv(text) {
  const source = normalizeText(text);
  if (source.length === 0) {
    return [];
  }

  const rows = [];
  let row = [];
  let field = "";
  let insideQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (insideQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        insideQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      insideQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      if (next === "\n") {
        continue;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);

  if (rows.length === 1 && rows[0].length === 1 && rows[0][0] === "") {
    return [];
  }

  return rows;
}

export function stringifyCsv(rows) {
  return rows.map((row) => row.map(escapeCsvField).join(",")).join("\n");
}

export function encodeLayerBundle(cell) {
  return LAYER_IDS.map((layerId) => escapeLayer(cell?.[layerId] ?? "")).join(LAYER_DELIMITER);
}

export function decodeLayerBundle(rawValue) {
  const value = normalizeText(rawValue);
  if (!value.includes(LAYER_DELIMITER)) {
    return createCell({ value });
  }

  const parts = splitEscapedBundle(value);
  const cell = createCell();
  LAYER_IDS.forEach((layerId, index) => {
    cell[layerId] = parts[index] ?? "";
  });

  if (parts.length > LAYER_IDS.length) {
    cell.source = parts.slice(3).join(LAYER_DELIMITER);
  }

  return cell;
}

export function importCsvToSheet(csvText) {
  const parsedRows = parseCsv(csvText);
  const rows = parsedRows.length
    ? parsedRows.map((row) => row.map((field) => decodeLayerBundle(field)))
    : createSheet(1, 1).rows;

  return ensureRectangularRows(rows);
}

export function exportSheetToCsv(sheet) {
  const { columnCount } = getDimensions(sheet);
  const rows = sheet.rows.map((row) =>
    Array.from({ length: columnCount }, (_, columnIndex) => encodeLayerBundle(row[columnIndex] ?? createCell()))
  );
  return stringifyCsv(rows);
}

export function columnName(index) {
  let value = index + 1;
  let label = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }

  return label;
}

function escapeCsvField(value) {
  const text = normalizeText(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function escapeLayer(value) {
  return normalizeText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(LAYER_DELIMITER, `\\${LAYER_DELIMITER}`);
}

function splitEscapedBundle(value) {
  const parts = [];
  let field = "";
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      field += char === "\\" || char === LAYER_DELIMITER ? char : `\\${char}`;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
    } else if (char === LAYER_DELIMITER) {
      parts.push(field);
      field = "";
    } else {
      field += char;
    }
  }

  if (escaped) {
    field += "\\";
  }

  parts.push(field);
  return parts;
}

function normalizeText(value) {
  return value == null ? "" : String(value);
}
