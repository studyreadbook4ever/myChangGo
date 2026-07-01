import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("browser UI starts from dimensions, edits four layers, resizes, imports, and exports", async (t) => {
  const browser = await startChromium(t);
  const page = await browser.open(pathToFileURL(resolve(projectRoot, "index.html")).href);

  t.after(async () => {
    await browser.close();
  });

  const title = await page.evaluate(() => document.querySelector("h1").textContent.trim());
  assert.equal(title, "Ontology Sheet");

  const initialSetup = await page.evaluate(() => ({
    setupHidden: document.querySelector("#setupScreen").classList.contains("is-hidden"),
    editorHidden: document.querySelector("#editorScreen").classList.contains("is-hidden"),
    toolbarHidden: document.querySelector("#editorToolbar").classList.contains("is-hidden"),
    rowDefault: document.querySelector("#rowCount").value,
    columnDefault: document.querySelector("#columnCount").value,
    layerValue: document.querySelector("#layerCount").value,
    layerDisabled: document.querySelector("#layerCount").disabled
  }));
  assert.deepEqual(initialSetup, {
    setupHidden: false,
    editorHidden: true,
    toolbarHidden: true,
    rowDefault: "4",
    columnDefault: "4",
    layerValue: "4",
    layerDisabled: true
  });

  const started = await page.evaluate(() => {
    document.querySelector("#rowCount").value = "3";
    document.querySelector("#columnCount").value = "2";
    document.querySelector("#setupForm").requestSubmit();
    return {
      state: window.OntologySheetApp.getState(),
      setupHidden: document.querySelector("#setupScreen").classList.contains("is-hidden"),
      editorHidden: document.querySelector("#editorScreen").classList.contains("is-hidden"),
      toolbarHidden: document.querySelector("#editorToolbar").classList.contains("is-hidden"),
      cellCount: document.querySelectorAll("[data-cell-key]").length,
      status: document.querySelector("#sheetStatus").textContent
    };
  });
  assert.equal(started.state.isReady, true);
  assert.equal(started.state.sheet.rows.length, 3);
  assert.equal(started.state.sheet.rows[0].length, 2);
  assert.equal(started.setupHidden, true);
  assert.equal(started.editorHidden, false);
  assert.equal(started.toolbarHidden, false);
  assert.equal(started.cellCount, 6);
  assert.equal(started.status, "3행 2열 · 높이 4 · 셀 내부 구분자 ␟");

  const resized = await page.evaluate(() => {
    document.querySelector("#addRow").click();
    document.querySelector("#addCol").click();
    document.querySelector("#removeRow").click();
    document.querySelector("#removeCol").click();
    document.querySelector("#removeRow").click();
    document.querySelector("#removeRow").click();
    document.querySelector("#removeRow").click();
    document.querySelector("#removeCol").click();
    document.querySelector("#removeCol").click();
    return {
      state: window.OntologySheetApp.getState(),
      removeRowDisabled: document.querySelector("#removeRow").disabled,
      removeColumnDisabled: document.querySelector("#removeCol").disabled,
      status: document.querySelector("#sheetStatus").textContent
    };
  });
  assert.equal(resized.state.sheet.rows.length, 1);
  assert.equal(resized.state.sheet.rows[0].length, 1);
  assert.equal(resized.removeRowDisabled, true);
  assert.equal(resized.removeColumnDisabled, true);
  assert.equal(resized.status, "1행 1열 · 높이 4 · 셀 내부 구분자 ␟");

  const topButton = await page.evaluate(() => {
    const rect = document.querySelector("#exportCsv").getBoundingClientRect();
    const header = document.querySelector(".topbar").getBoundingClientRect();
    return {
      text: document.querySelector("#exportCsv").textContent.trim(),
      buttonTop: Math.round(rect.top),
      headerTop: Math.round(header.top)
    };
  });
  assert.equal(topButton.text, "이거 csv로 내보내기");
  assert.ok(topButton.buttonTop >= topButton.headerTop);

  const exported = await page.evaluate(() => {
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    window.addEventListener("ontology-sheet:export", (event) => {
      window.__lastExportCsv = event.detail.csv;
    });

    const values = {
      value: "매출, 서울",
      procedure: "sum(orders.amount)",
      period: "P1M\nUTC+09",
      source: "https://example.test/report?id=7"
    };

    for (const [layer, value] of Object.entries(values)) {
      const textarea = document.querySelector(`[data-layer-input="${layer}"]`);
      textarea.value = value;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    document.querySelector("#exportCsv").click();
    return window.__lastExportCsv;
  });
  assert.match(exported, /매출, 서울/);
  assert.match(exported, /sum\(orders\.amount\)/);
  assert.match(exported, /P1M/);
  assert.match(exported, /https:\/\/example\.test/);

  const sourceLayerText = await page.evaluate(() => {
    document.querySelector('[data-layer-tab="source"]').click();
    return document.querySelector('[data-cell-key="0-0"] .cell-value').textContent;
  });
  assert.equal(sourceLayerText, "https://example.test/report?id=7");

  const importedState = await page.evaluate(() => {
    const csv = '"A␟proc(A)␟weekly␟source://alpha",plain\n"with comma, ok␟p2␟monthly␟doc,row",';
    document.querySelector("#csvPaste").value = csv;
    document.querySelector("#importPasted").click();
    return {
      state: window.OntologySheetApp.getState(),
      status: document.querySelector("#sheetStatus").textContent,
      activeTitle: document.querySelector("#activeCellTitle").textContent
    };
  });

  assert.equal(importedState.activeTitle, "A1");
  assert.equal(importedState.status, "2행 2열 · 높이 4 · 셀 내부 구분자 ␟");
  assert.equal(importedState.state.sheet.rows[0][0].value, "A");
  assert.equal(importedState.state.sheet.rows[0][0].procedure, "proc(A)");
  assert.equal(importedState.state.sheet.rows[0][0].period, "weekly");
  assert.equal(importedState.state.sheet.rows[0][0].source, "source://alpha");
  assert.equal(importedState.state.sheet.rows[0][1].value, "plain");
  assert.equal(importedState.state.sheet.rows[1][1].value, "");

  const layout = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button, .button-like")];
    const textareas = [...document.querySelectorAll("textarea")];
    return {
      everyButtonFits: buttons.every((button) => button.scrollWidth <= button.clientWidth + 1),
      everyTextareaVisible: textareas.every((textarea) => textarea.offsetWidth > 240 && textarea.offsetHeight > 50),
      cellHeight: Math.round(document.querySelector(".cell-button").getBoundingClientRect().height)
    };
  });

  assert.equal(layout.everyButtonFits, true);
  assert.equal(layout.everyTextareaVisible, true);
  assert.equal(layout.cellHeight, 92);
});

async function startChromium(t) {
  const userDataDir = await mkdtemp(join(tmpdir(), "ontology-sheet-chrome-"));
  const chromium = spawn("/usr/bin/chromium", [
    "--headless=new",
    "--allow-file-access-from-files",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-crashpad",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--noerrdialogs",
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });

  t.after(async () => {
    chromium.kill("SIGKILL");
    await rm(userDataDir, { recursive: true, force: true });
  });

  const cdp = new CdpPipeConnection(chromium.stdio[3], chromium.stdio[4]);
  await Promise.race([
    cdp.send("Browser.getVersion"),
    new Promise((_, rejectReady) => {
      chromium.once("exit", (code) => {
        rejectReady(new Error(`Chromium exited early with code ${code}`));
      });
    })
  ]);

  return {
    open: async (url) => {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true
      });
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      const loaded = cdp.waitForEvent("Page.loadEventFired", (event) => event.sessionId === sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      return {
        evaluate: (fn) => evaluateInPage(cdp, sessionId, fn)
      };
    },
    close: async () => {
      cdp.close();
      chromium.kill("SIGTERM");
    }
  };
}

async function evaluateInPage(cdp, sessionId, fn) {
  const response = await cdp.send("Runtime.evaluate", {
    expression: `(${fn})()`,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);

  if (response.exceptionDetails) {
    const exception = response.exceptionDetails.exception;
    throw new Error(exception?.description ?? exception?.value ?? response.exceptionDetails.text);
  }

  return response.result.value;
}

class CdpPipeConnection {
  constructor(pipeWrite, pipeRead) {
    this.pipeWrite = pipeWrite;
    this.pipeRead = pipeRead;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.buffer = "";

    pipeRead.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let separatorIndex = this.buffer.indexOf("\0");
      while (separatorIndex !== -1) {
        const rawMessage = this.buffer.slice(0, separatorIndex);
        this.buffer = this.buffer.slice(separatorIndex + 1);
        if (rawMessage) {
          this.handleMessage(JSON.parse(rawMessage));
        }
        separatorIndex = this.buffer.indexOf("\0");
      }
    });
  }

  handleMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolveResponse, rejectResponse } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        rejectResponse(new Error(message.error.message));
      } else {
        resolveResponse(message.result ?? {});
      }
      return;
    }

    this.eventWaiters = this.eventWaiters.filter((waiter) => {
      if (waiter.method === message.method && waiter.predicate(message)) {
        clearTimeout(waiter.timeout);
        waiter.resolveEvent(message);
        return false;
      }
      return true;
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(id, { resolveResponse, rejectResponse });
      this.pipeWrite.write(`${JSON.stringify(message)}\0`);
    });
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timeout = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.resolveEvent !== resolveEvent);
        rejectEvent(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.eventWaiters.push({ method, predicate, resolveEvent, timeout });
    });
  }

  close() {
    this.pipeWrite.end();
  }
}
