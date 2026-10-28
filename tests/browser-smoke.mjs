/** Real HTTP shell and browser flows; agent execution is stubbed so no Docker or inference is needed. */
import { chromium } from "playwright";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const root = resolve(".test-data"); await mkdir(root, { recursive: true });
const dataDir = await mkdtemp(join(root, "browser-"));
const port = 18800 + Math.floor(Math.random() * 500), origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/dist/index.js"], { env: { ...process.env, RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_PUBLIC_ORIGIN: origin, RELAY_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let log = ""; child.stdout.on("data", data => log += data); child.stderr.on("data", data => log += data);
let browser, browserServer;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) { try { if ((await fetch(`${origin}/api/session`)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.ok(ready, `Server failed to start: ${log}`);
  assert.equal((await fetch(`${origin}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json", Origin: "https://wrong.example" }, body: JSON.stringify({ name: "blocked" }) })).status, 403);
  await assert.rejects(readFile(join(dataDir, "access-token")), /ENOENT/);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace("http", "ws")}/ws/events`, { origin: "https://wrong.example" });
    socket.once("open", () => { socket.close(); reject(new Error("Cross-origin socket was accepted")); });
    socket.once("error", error => { try { assert.match(error.message, /403/); resolve(); } catch (failure) { reject(failure); } });
  });
  browserServer = await chromium.launchServer({ headless: true, ...(process.env.RELAY_BROWSER_CHANNEL ? { channel: process.env.RELAY_BROWSER_CHANNEL } : process.platform === "win32" ? { channel: "msedge" } : {}) });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#new-project").click();
  await page.getByLabel("Project name").fill("Relay acceptance");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "No tasks" }).waitFor();
  await page.locator("#project-title").filter({ hasText: "Relay acceptance" }).waitFor();
  await page.locator("#project-switcher summary").click();
  await page.screenshot({ path: join(root, "relay-project-menu-desktop.png") });
  await page.locator("#project-options [data-project='all']").click();
  await page.locator("#project-title").filter({ hasText: "All projects" }).waitFor();
  const original = await page.evaluate(() => fetch("/api/state").then(response => response.json()));
  const primary = original.workspaces[0];
  assert.ok(primary.id);
  await page.locator("#project-switcher summary").click();
  await page.locator(`#project-options [data-project='${primary.id}']`).click();
  const groupId = randomUUID();
  const copyA = { ...primary, id: randomUUID(), name: "Pagination · A", kind: "agent", parentId: primary.id, groupId, baseFingerprint: "base", baselineRevision: "baseline", state: "stopped", appliedAt: null };
  const copyB = { ...copyA, id: randomUUID(), name: "Pagination · B" };
  const date = new Date().toISOString();
  const runA = { id: randomUUID(), title: "Pagination · A", workspaceId: copyA.id, prompt: "Add pagination and run tests.", state: "waiting", createdAt: date, startedAt: date, finishedAt: null, error: null, threadId: "test-thread", turnId: "test-turn" };
  const runB = { ...runA, id: randomUUID(), title: "Pagination · B", workspaceId: copyB.id, prompt: "Try cursor pagination.", state: "completed" };
  const fixture = { ...original, workspaces: [primary], runs: [], system: { ...original.system, docker: true, imageReady: true, message: "Ready" } };
  const patch = "diff --git a/src/index.ts b/src/index.ts\nindex 1111111..2222222 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const pageSize = 10;\n+export const pageSize = 20;\n";
  const proposals = new Map([copyA, copyB].map(copy => [copy.id, { id: randomUUID(), workspaceId: copy.id, parentId: primary.id, baseFingerprint: "base", resultFingerprint: "result", patch, summary: "1 file changed", createdAt: date, appliedAt: null }]));
  let approvalResolved = false, createdRequest;
  await page.route("**/api/state", route => route.fulfill({ json: fixture }));
  await page.route("**/api/workspaces/**", route => {
    const url = new URL(route.request().url()), parts = url.pathname.split("/"), id = parts[3], action = parts[4];
    if (action === "tasks") {
      createdRequest = route.request().postDataJSON(); fixture.workspaces.push(copyA); fixture.runs.push(runA);
      return route.fulfill({ status: 201, json: { workspace: copyA, run: runA } });
    }
    if (action === "parallel") { fixture.workspaces.push(copyB); fixture.runs.push(runB); return route.fulfill({ status: 201, json: [copyA, copyB] }); }
    if (action === "review") return route.fulfill({ json: proposals.get(id) });
    return route.continue();
  });
  await page.route("**/api/runs/**", route => {
    const url = new URL(route.request().url()), parts = url.pathname.split("/"), id = parts[3], action = parts[4];
    if (action === "events") return route.fulfill({ json: url.searchParams.get("after") === "0" ? [{ sequence: 1, runId: id, type: "item/completed", createdAt: date, data: { item: { id: "agent-message", type: "agentMessage", text: "Implemented pagination." } } }] : [] });
    if (action === "approvals") {
      if (route.request().method() === "POST") { approvalResolved = true; runA.state = "completed"; return route.fulfill({ json: { resolved: true } }); }
      return route.fulfill({ json: id === runA.id && !approvalResolved ? [{ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "npm test" } }] : [] });
    }
    if (action === "cancel") { runA.state = "cancelled"; return route.fulfill({ json: runA }); }
    return route.continue();
  });
  await page.route("**/api/changes/*/apply", route => {
    const proposal = [...proposals.values()].find(item => route.request().url().includes(item.id));
    proposal.appliedAt = new Date().toISOString(); copyA.appliedAt = proposal.appliedAt;
    return route.fulfill({ json: proposal });
  });
  await page.getByRole("button", { name: /New task/ }).first().click();
  await page.getByLabel("Task name").fill("Pagination");
  await page.getByLabel("Instructions", { exact: true }).fill("Add pagination and run tests.");
  await page.getByRole("button", { name: "Start task" }).click();
  await page.getByRole("heading", { name: "Pagination · A" }).waitFor();
  assert.equal(createdRequest.isolated, true);
  await page.getByRole("button", { name: "Allow" }).click();
  await page.getByRole("button", { name: /Review changes/ }).waitFor();
  assert.equal(approvalResolved, true);
  fixture.workspaces.push(copyB); fixture.runs.push(runB);
  await page.reload();
  await page.getByRole("button", { name: "Compare attempts" }).click();
  await page.getByRole("heading", { name: "Compare attempts" }).waitFor();
  assert.equal(await page.locator(".review-panel").count(), 2);
  await page.screenshot({ path: join(root, "relay-desktop-review.png"), fullPage: true });
  await page.getByRole("button", { name: /Task activity/ }).click();
  await page.getByRole("button", { name: /Review changes/ }).click();
  await page.getByText("export const pageSize = 20;").waitFor();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Apply to project" }).click();
  await page.getByRole("button", { name: "Applied" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Mobile view overflows");
  await page.screenshot({ path: join(root, "relay-mobile-review.png"), fullPage: true });
  await page.getByRole("button", { name: /Task activity/ }).click();
  await page.getByRole("button", { name: /All tasks/ }).click();
  assert.equal(await page.locator("#inbox").isVisible(), true);
  await page.locator("#project-switcher summary").click();
  await page.screenshot({ path: join(root, "relay-project-menu-mobile.png") });
  await page.screenshot({ path: join(root, "relay-mobile-inbox.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: project creation, isolated task, approval, activity, review, apply, mobile navigation and overflow, origin checks.");
} finally {
  await browser?.close();
  if (browserServer) {
    const processId = browserServer.process().pid;
    if (process.platform === "win32" && processId) await promisify(execFile)("taskkill", ["/PID", String(processId), "/T", "/F"], { windowsHide: true }).catch(() => {});
    await browserServer.kill();
  }
  if (child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 5000))]); }
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  assert.ok(dataDir.startsWith(root)); await rm(dataDir, { recursive: true, force: true });
}
