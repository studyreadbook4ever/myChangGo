import {
  LAYER_DELIMITER,
  LAYERS,
  addColumn,
  addRow,
  columnName,
  createSheet,
  exportSheetToCsv,
  getDimensions,
  importCsvToSheet,
  removeColumn,
  removeRow,
  setCellLayer
} from "./sheet-model.js";

const state = {
  sheet: null,
  isReady: false,
  activeRow: 0,
  activeColumn: 0,
  activeLayer: "value"
};

const elements = {
  addColumn: document.querySelector("#addCol"),
  addRow: document.querySelector("#addRow"),
  cellFields: document.querySelector("#cellFields"),
  columnCount: document.querySelector("#columnCount"),
  csvFile: document.querySelector("#csvFile"),
  csvPaste: document.querySelector("#csvPaste"),
  editorScreen: document.querySelector("#editorScreen"),
  editorToolbar: document.querySelector("#editorToolbar"),
  exportCsv: document.querySelector("#exportCsv"),
  importPasted: document.querySelector("#importPasted"),
  removeColumn: document.querySelector("#removeCol"),
  removeRow: document.querySelector("#removeRow"),
  rowCount: document.querySelector("#rowCount"),
  setupForm: document.querySelector("#setupForm"),
  setupScreen: document.querySelector("#setupScreen"),
  activeCellTitle: document.querySelector("#activeCellTitle"),
  layerBadge: document.querySelector("#layerBadge"),
  sheetStatus: document.querySelector("#sheetStatus"),
  tableHost: document.querySelector("#tableHost")
};

bindEvents();
render();

window.OntologySheetApp = {
  startSheet,
  exportCsv: () => (state.sheet ? exportSheetToCsv(state.sheet) : ""),
  importCsv: (csvText) => {
    importCsv(csvText);
  },
  getState: () => structuredClone(state),
  setActiveCell: (rowIndex, columnIndex) => {
    selectCell(rowIndex, columnIndex);
  }
};

function bindEvents() {
  elements.setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    startSheet(elements.rowCount.value, elements.columnCount.value);
  });

  elements.exportCsv.addEventListener("click", () => {
    if (!state.sheet) {
      return;
    }

    const csv = exportSheetToCsv(state.sheet);
    downloadCsv(csv);
    window.dispatchEvent(new CustomEvent("ontology-sheet:export", { detail: { csv } }));
  });

  elements.csvFile.addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) {
      return;
    }

    const text = await file.text();
    importCsv(text);
    event.target.value = "";
  });

  elements.importPasted.addEventListener("click", () => {
    importCsv(elements.csvPaste.value);
  });

  elements.addRow.addEventListener("click", () => {
    if (!state.sheet) {
      return;
    }

    state.sheet = addRow(state.sheet);
    render();
  });

  elements.removeRow.addEventListener("click", () => {
    if (!state.sheet) {
      return;
    }

    state.sheet = removeRow(state.sheet);
    render();
  });

  elements.addColumn.addEventListener("click", () => {
    if (!state.sheet) {
      return;
    }

    state.sheet = addColumn(state.sheet);
    render();
  });

  elements.removeColumn.addEventListener("click", () => {
    if (!state.sheet) {
      return;
    }

    state.sheet = removeColumn(state.sheet);
    render();
  });

  document.querySelectorAll("[data-layer-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeLayer = button.dataset.layerTab;
      render();
    });
  });
}

function startSheet(rowCount, columnCount) {
  state.sheet = createSheet(
    readDimension(rowCount, 1, 200),
    readDimension(columnCount, 1, 100)
  );
  state.isReady = true;
  state.activeRow = 0;
  state.activeColumn = 0;
  render();
}

function importCsv(csvText) {
  state.sheet = importCsvToSheet(csvText);
  state.isReady = true;
  state.activeRow = 0;
  state.activeColumn = 0;
  render();
}

function render() {
  renderScreens();
  if (!state.isReady || !state.sheet) {
    return;
  }

  keepActiveCellInBounds();
  renderDimensionControls();
  renderLayerTabs();
  renderTable();
  renderInspector();
  renderStatus();
}

function renderScreens() {
  const isReady = state.isReady && state.sheet;
  elements.setupScreen.classList.toggle("is-hidden", isReady);
  elements.editorScreen.classList.toggle("is-hidden", !isReady);
  elements.editorToolbar.classList.toggle("is-hidden", !isReady);
}

function renderDimensionControls() {
  const { rowCount, columnCount } = getDimensions(state.sheet);
  elements.removeRow.disabled = rowCount <= 1;
  elements.removeColumn.disabled = columnCount <= 1;
}

function renderLayerTabs() {
  document.querySelectorAll("[data-layer-tab]").forEach((button) => {
    const isActive = button.dataset.layerTab === state.activeLayer;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  const activeLayer = getLayer(state.activeLayer);
  elements.layerBadge.textContent = activeLayer.label;
  elements.layerBadge.style.background = getLayerColor(activeLayer.id);
}

function renderTable() {
  const { columnCount } = getDimensions(state.sheet);
  const table = document.createElement("table");
  table.className = "ontology-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(createHeaderCell(""));
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    headRow.append(createHeaderCell(columnName(columnIndex)));
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  state.sheet.rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    tr.append(createHeaderCell(String(rowIndex + 1), "row"));

    row.forEach((cell, columnIndex) => {
      const td = document.createElement("td");
      const button = document.createElement("button");
      const visibleValue = cell[state.activeLayer] || "";
      button.type = "button";
      button.className = "cell-button";
      button.dataset.cellKey = `${rowIndex}-${columnIndex}`;
      button.classList.toggle("is-active", rowIndex === state.activeRow && columnIndex === state.activeColumn);
      button.setAttribute("aria-label", `${columnName(columnIndex)}${rowIndex + 1}`);
      button.addEventListener("click", () => selectCell(rowIndex, columnIndex));

      const value = document.createElement("span");
      value.className = `cell-value${visibleValue ? "" : " cell-placeholder"}`;
      value.textContent = visibleValue || "빈 셀";

      button.append(value, createLayerStack(cell));
      td.append(button);
      tr.append(td);
    });

    tbody.append(tr);
  });

  table.append(tbody);
  elements.tableHost.replaceChildren(table);
}

function renderInspector() {
  const cell = getActiveCell();
  elements.activeCellTitle.textContent = `${columnName(state.activeColumn)}${state.activeRow + 1}`;
  elements.cellFields.replaceChildren(
    ...LAYERS.map((layer) => {
      const group = document.createElement("div");
      group.className = "field-group";

      const label = document.createElement("label");
      const inputId = `field-${layer.id}`;
      label.setAttribute("for", inputId);
      label.textContent = layer.label;

      const textarea = document.createElement("textarea");
      textarea.id = inputId;
      textarea.dataset.layerInput = layer.id;
      textarea.value = cell[layer.id] ?? "";
      textarea.style.borderColor = layer.id === state.activeLayer ? getLayerColor(layer.id) : "";
      textarea.addEventListener("focus", () => {
        state.activeLayer = layer.id;
        renderLayerTabs();
        renderTable();
      });
      textarea.addEventListener("input", (event) => {
        state.sheet = setCellLayer(
          state.sheet,
          state.activeRow,
          state.activeColumn,
          layer.id,
          event.target.value
        );
        renderTable();
        renderStatus();
      });

      group.append(label, textarea);
      return group;
    })
  );
}

function renderStatus() {
  const { rowCount, columnCount } = getDimensions(state.sheet);
  elements.sheetStatus.textContent = `${rowCount}행 ${columnCount}열 · 높이 ${LAYERS.length} · 셀 내부 구분자 ${LAYER_DELIMITER}`;
}

function selectCell(rowIndex, columnIndex) {
  state.activeRow = rowIndex;
  state.activeColumn = columnIndex;
  render();
}

function keepActiveCellInBounds() {
  const { rowCount, columnCount } = getDimensions(state.sheet);
  state.activeRow = Math.min(state.activeRow, Math.max(0, rowCount - 1));
  state.activeColumn = Math.min(state.activeColumn, Math.max(0, columnCount - 1));
}

function getActiveCell() {
  return state.sheet.rows[state.activeRow][state.activeColumn];
}

function createHeaderCell(text, scope = "col") {
  const th = document.createElement("th");
  th.scope = scope;
  th.className = scope === "row" ? "row-head" : "";
  th.textContent = text;
  return th;
}

function createLayerStack(cell) {
  const stack = document.createElement("span");
  stack.className = "layer-stack";
  LAYERS.forEach((layer) => {
    const dot = document.createElement("span");
    dot.className = `layer-dot${cell[layer.id] ? " has-data" : ""}`;
    dot.dataset.layer = layer.id;
    stack.append(dot);
  });
  return stack;
}

function getLayer(layerId) {
  return LAYERS.find((layer) => layer.id === layerId) ?? LAYERS[0];
}

function getLayerColor(layerId) {
  return {
    value: "#1f6f5b",
    procedure: "#b7791f",
    period: "#2b6f87",
    source: "#a04655"
  }[layerId] ?? "#1f6f5b";
}

function readDimension(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.min(max, Math.max(min, parsed));
}

function downloadCsv(csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ontology-sheet-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
