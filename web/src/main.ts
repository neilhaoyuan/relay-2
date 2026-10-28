import type { AgentRun, ChangeProposal, RunEvent, Workspace, SystemStatus } from "@relay/contracts";
import { api, eventsSocket } from "./api";
import "./style.css";

type State = { workspaces: Workspace[]; runs: AgentRun[]; system: SystemStatus };
type Approval = { id: string | number; method: string; params: Record<string, unknown> };
type Screen = "activity" | "review";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const ended = new Set(["completed", "failed", "cancelled", "interrupted"]);
const labels: Record<string, string> = { queued: "Queued", starting: "Starting", running: "Working", waiting: "Needs approval", stopping: "Stopping", completed: "Finished", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };
const when = (value: string) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
let state: State = { workspaces: [], runs: [], system: {} as SystemStatus };
let projectId = "all", selectedRunId = new URL(location.href).searchParams.get("run") ?? "", filter: "open" | "all" = "open";
let mobileDetailOpen = !!selectedRunId;
let screen: Screen = "activity", reviewIds: string[] = [], socket: WebSocket | undefined;
let refreshing = false, refreshQueued = false, eventCursor = 0, toastTimer = 0;
let events: RunEvent[] = [], approvals: Approval[] = [], detailKey = "";
const proposals = new Map<string, ChangeProposal>(), chosenFiles = new Map<string, number>();

function notice(message: string): void {
  const target = $("toast"); target.textContent = message; target.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => target.hidden = true, 5500);
}
async function runAction(work: () => Promise<void>): Promise<void> {
  try { await work(); } catch (error) { notice((error as Error).message); }
}
function workspace(id: string): Workspace | undefined { return state.workspaces.find(item => item.id === id); }
function run(id = selectedRunId): AgentRun | undefined { return state.runs.find(item => item.id === id); }
function project(item: Workspace | undefined): Workspace | undefined { return workspace(item?.parentId ?? item?.id ?? ""); }
function isBusy(id: string): boolean { return state.runs.some(item => item.workspaceId === id && !ended.has(item.state)); }
function isReady(item: AgentRun): boolean {
  const source = workspace(item.workspaceId);
  return ended.has(item.state) && !!source?.parentId && !source.appliedAt && source.state !== "discarded";
}
function category(item: AgentRun): string {
  return item.state === "waiting" ? "Needs you" : !ended.has(item.state) ? "In progress" : isReady(item) ? "Ready to review" : "History";
}
function projectMatches(item: AgentRun): boolean {
  return projectId === "all" || (workspace(item.workspaceId)?.parentId ?? item.workspaceId) === projectId;
}

function renderProjects(): void {
  const primaries = state.workspaces.filter(item => item.kind === "primary" && item.state !== "discarded");
  if (projectId !== "all" && !primaries.some(item => item.id === projectId)) projectId = "all";
  $("project-title").textContent = projectId === "all" ? "All projects" : primaries.find(item => item.id === projectId)?.name ?? "All projects";
  const options = [{ id: "all", name: "All projects" }, ...primaries].map(item => `<button type="button" data-project="${item.id}" class="project-option" aria-current="${item.id === projectId ? "true" : "false"}"><span>${html(item.name)}</span>${item.id === projectId ? "<small>Current</small>" : ""}</button>`).join("");
  if ($("project-options").innerHTML !== options) $("project-options").innerHTML = options;
}
function renderList(): void {
  const open = filter === "open";
  for (const name of ["open", "all"] as const) {
    const button = $<HTMLButtonElement>(`filter-${name}`); button.classList.toggle("active", filter === name); button.setAttribute("aria-pressed", String(filter === name));
  }
  const visible = state.runs.filter(projectMatches).filter(item => !open || category(item) !== "History");
  const order = ["Needs you", "In progress", "Ready to review", "History"];
  const content = order.map(group => {
    const items = visible.filter(item => category(item) === group).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!items.length) return "";
    return `<div class="list-group"><h2>${group} <span>${items.length}</span></h2>${items.map(item => {
      const source = workspace(item.workspaceId), parent = project(source);
      return `<button class="task-row ${item.id === selectedRunId ? "selected" : ""}" data-run="${item.id}" type="button" aria-current="${item.id === selectedRunId ? "true" : "false"}">
        <span class="task-row-top"><span class="status ${item.state}"><i></i>${labels[item.state]}</span><time>${html(when(item.createdAt))}</time></span>
        <strong>${html(item.title ?? item.prompt)}</strong>
        <span class="task-row-project">${html(parent?.name ?? source?.name ?? "Project")}${source?.kind === "agent" ? " · Isolated" : ""}</span>
      </button>`;
    }).join("")}</div>`;
  }).join("");
  $("task-list").innerHTML = content || `<div class="empty-list"><h2>${state.workspaces.length ? open && state.runs.length ? "No open tasks" : "No tasks" : "No projects"}</h2><button class="button" data-action="${state.workspaces.length ? "new-task" : "new-project"}" type="button">${state.workspaces.length ? "New task" : "New project"}</button></div>`;
}
function setSelection(id: string, next: Screen = "activity"): void {
  if (id !== selectedRunId) { events = []; approvals = []; eventCursor = 0; }
  selectedRunId = id; screen = next; detailKey = ""; mobileDetailOpen = !!id;
  const url = new URL(location.href);
  if (id) url.searchParams.set("run", id); else url.searchParams.delete("run");
  history.replaceState(null, "", url);
  $("shell").classList.toggle("show-detail", mobileDetailOpen);
  renderList(); renderDetail();
  if (id) void runAction(() => loadRun(id));
}
async function loadRun(id: string): Promise<void> {
  for (;;) {
    const batch = await api<RunEvent[]>(`/runs/${id}/events?after=${eventCursor}`);
    if (id !== selectedRunId) return;
    for (const event of batch) if (event.sequence > eventCursor) { events.push(event); eventCursor = event.sequence; }
    if (batch.length < 500) break;
  }
  const pending = await api<Approval[]>(`/runs/${id}/approvals`);
  if (id !== selectedRunId) return;
  approvals = pending; renderDetail();
}
async function refresh(): Promise<void> {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  try {
    state = await api<State>("/state");
    if (selectedRunId && !run()) selectedRunId = "";
    if (!selectedRunId && state.runs.length && matchMedia("(min-width: 760px)").matches) {
      selectedRunId = [...state.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].id;
    }
    $("shell").classList.toggle("show-detail", mobileDetailOpen && !!selectedRunId);
    $("updated-at").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    renderProjects(); renderList();
    if (selectedRunId) await loadRun(selectedRunId); else renderDetail();
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; void runAction(refresh); }
  }
}
function connect(): void {
  socket = eventsSocket();
  socket.onmessage = () => void runAction(refresh);
  socket.onopen = () => void runAction(refresh);
  socket.onclose = () => window.setTimeout(connect, 2500);
}

type Item = { id: string; type: string; title: string; text: string; status?: string };
function activityItems(): Item[] {
  const items = new Map<string, Item>();
  for (const event of events) {
    const data = event.data as { item?: { id: string; type: string; text?: string; command?: string; aggregatedOutput?: string; status?: string; exitCode?: number; changes?: unknown }; itemId?: string; delta?: string };
    if (event.type === "item/agentMessage/delta" || event.type === "item/commandExecution/outputDelta") {
      const id = data.itemId ?? String(event.sequence), message = event.type.includes("agentMessage");
      const item = items.get(id) ?? { id, type: message ? "message" : "command", title: message ? "Agent" : "Command", text: "" };
      item.text += data.delta ?? ""; items.set(id, item);
    }
    if ((event.type === "item/started" || event.type === "item/completed") && data.item) {
      const source = data.item, previous = items.get(source.id);
      if (source.type === "agentMessage") items.set(source.id, { id: source.id, type: "message", title: "Agent", text: source.text ?? previous?.text ?? "" });
      if (source.type === "commandExecution") items.set(source.id, { id: source.id, type: "command", title: source.command ?? "Command", text: source.aggregatedOutput ?? previous?.text ?? "", status: source.exitCode == null ? source.status : `Exit ${source.exitCode}` });
      if (source.type === "fileChange") items.set(source.id, { id: source.id, type: "files", title: "Files changed", text: JSON.stringify(source.changes ?? [], null, 2), status: source.status });
    }
  }
  return [...items.values()];
}
function renderActivity(item: AgentRun): string {
  const source = workspace(item.workspaceId), parent = project(source), active = !ended.has(item.state);
  const siblings = state.workspaces.filter(w => w.groupId && w.groupId === source?.groupId && w.id !== source.id && !isBusy(w.id) && !w.appliedAt && w.state !== "discarded");
  const timeline = activityItems();
  return `<div class="detail-body">
    <button class="back-link" data-action="back" type="button">All tasks</button>
    <div class="detail-heading"><p class="eyebrow">${html(parent?.name ?? source?.name ?? "Project")} <span class="dot">·</span> ${html(when(item.createdAt))}</p><h1>${html(item.title ?? item.prompt)}</h1><div class="detail-meta"><span class="status ${item.state}"><i></i>${labels[item.state]}</span>${source?.parentId ? '<span>Isolated copy</span>' : '<span>Primary project</span>'}</div></div>
    ${item.error ? `<div class="inline-error" role="alert">${html(item.error)}</div>` : ""}
    ${approvals.map(request => `<section class="approval"><p class="eyebrow">Decision needed</p><h2>Agent requests approval</h2><pre>${html(request.params.command ?? request.params.reason ?? "Review the proposed file change.")}</pre><div class="action-row"><button class="button primary" data-action="approve" data-request="${html(request.id)}" type="button">Allow</button><button class="button" data-action="decline" data-request="${html(request.id)}" type="button">Decline</button></div></section>`).join("")}
    <section class="task-prompt"><h2>Instructions</h2><p>${html(item.prompt)}</p></section>
    <section class="activity-log"><div class="section-line"><h2>Activity</h2><span>${timeline.length ? `${timeline.length} updates` : active ? "Live" : "No updates"}</span></div>
      ${timeline.length ? timeline.map(entry => entry.type === "message" ? `<div class="log-message"><span class="log-label">Agent</span><p>${html(entry.text)}</p></div>` : `<details class="log-tool"><summary><span>${html(entry.title)}</span><small>${html(entry.status ?? "")}</small></summary><pre>${html(entry.text.slice(-20000) || "No output")}</pre></details>`).join("") : `<p class="quiet-line">${item.state === "queued" ? "Waiting for capacity." : active ? "Starting…" : "No activity recorded."}</p>`}
    </section>
    <div class="detail-actions">
      ${source?.parentId && !active && !source.appliedAt && source.state !== "discarded" ? '<button class="button primary" data-action="review" type="button">Review changes</button>' : ""}
      ${siblings.length ? `<button class="button" data-action="compare" data-other="${siblings[0].id}" type="button">Compare attempts</button>` : ""}
      ${!active && source?.state !== "discarded" ? '<button class="button" data-action="continue" type="button">Continue task</button>' : ""}
      ${active ? '<button class="button danger" data-action="cancel" type="button">Cancel run</button>' : ""}
      ${source?.parentId && !active && source.state !== "discarded" ? '<button class="text-button muted-action" data-action="discard" type="button">Discard copy</button>' : ""}
    </div>
  </div>`;
}
type PatchFile = { path: string; lines: string[]; binary: boolean; deleted: boolean };
function patchFiles(patch: string): PatchFile[] {
  return patch.split(/(?=^diff --git )/m).filter(part => part.startsWith("diff --git ")).map(part => {
    const lines = part.split("\n"), before = lines.find(line => line.startsWith("--- "))?.slice(4), after = lines.find(line => line.startsWith("+++ "))?.slice(4);
    let path = (after && after !== "/dev/null" ? after : before) ?? lines[0].replace(/^diff --git a\//, "").split(" b/")[0];
    if (path.startsWith('"')) { try { path = JSON.parse(path); } catch { /* Keep the Git label. */ } }
    return { path: path.replace(/^[ab]\//, ""), lines, binary: lines.some(line => line === "GIT binary patch" || line.startsWith("Binary files ")), deleted: after === "/dev/null" };
  });
}
function diff(file: PatchFile): string {
  if (file.binary) return '<p class="quiet-line">Binary file changed. Inspect it in the repository before applying.</p>';
  const lines = file.lines.filter(line => /^(\+\+\+|---|@@|\+|-| |\\)/.test(line) && !line.startsWith("+++") && !line.startsWith("---")).slice(0, 1200);
  return `<div class="diff-lines">${lines.map(line => `<div class="diff-line ${line.startsWith("+") ? "addition" : line.startsWith("-") ? "removal" : line.startsWith("@@") ? "hunk" : ""}"><span aria-hidden="true">${html(line[0] ?? " ")}</span><code>${html(line.slice(1))}</code></div>`).join("")}</div>${file.lines.length > 1200 ? '<p class="quiet-line">Preview limited to 1,200 lines.</p>' : ""}`;
}
function reviewPanel(id: string): string {
  const proposal = proposals.get(id), source = workspace(id);
  if (!proposal) return `<section class="review-panel"><p class="quiet-line">Capturing changes…</p></section>`;
  const files = patchFiles(proposal.patch), index = Math.min(chosenFiles.get(id) ?? 0, Math.max(0, files.length - 1)), file = files[index];
  return `<section class="review-panel" data-review="${id}">
    <div class="review-title"><div><p class="eyebrow">${html(source?.kind === "agent" ? "Attempt" : "Experiment")}</p><h2>${html(source?.name ?? "Changes")}</h2></div><span class="review-count">${files.length} file${files.length === 1 ? "" : "s"}</span></div>
    <pre class="review-summary">${html(proposal.summary || "No changes")}</pre>
    ${files.length ? `<div class="file-picker" aria-label="Changed files">${files.map((entry, i) => `<button class="file-option ${i === index ? "active" : ""}" data-action="file" data-review="${id}" data-index="${i}" aria-pressed="${i === index}" type="button">${html(entry.path)}${entry.deleted ? " <small>deleted</small>" : entry.binary ? " <small>binary</small>" : ""}</button>`).join("")}</div><div class="file-diff"><div class="file-diff-head">${html(file.path)}</div>${diff(file)}</div>` : '<p class="quiet-line">This copy matches its starting point.</p>'}
    <div class="review-footer"><button class="button primary" data-action="apply" data-review="${id}" type="button" ${!proposal.patch || !!proposal.appliedAt || !!source?.appliedAt ? "disabled" : ""}>${source?.appliedAt || proposal.appliedAt ? "Applied" : "Apply to project"}</button><span>Applies all changed files. No commit or push.</span></div>
  </section>`;
}
function renderReview(item: AgentRun): string {
  return `<div class="detail-body review-body"><button class="back-link" data-action="activity" type="button">Task activity</button><div class="detail-heading"><p class="eyebrow">Review</p><h1>${reviewIds.length > 1 ? "Compare attempts" : html(item.title ?? item.prompt)}</h1></div>${reviewIds.map(reviewPanel).join("")}</div>`;
}
function renderDetail(): void {
  const item = run(), target = $("detail-content");
  if (!item) { target.innerHTML = '<div class="detail-empty"><h2>Select a task</h2></div>'; return; }
  const key = `${item.id}:${item.state}:${item.error}:${screen}:${eventCursor}:${approvals.map(value => value.id).join(",")}:${reviewIds.join(",")}:${[...proposals.values()].map(value => `${value.id}:${value.appliedAt}`).join(",")}:${[...chosenFiles].join(",")}`;
  if (key === detailKey) return;
  detailKey = key;
  const prior = $("detail").scrollTop;
  target.innerHTML = screen === "review" ? renderReview(item) : renderActivity(item);
  $("detail").scrollTop = prior;
}

type DialogSubmit = (values: FormData) => Promise<void>;
let dialogSubmit: DialogSubmit = async () => {};
function dialog(kicker: string, title: string, fields: string, submitLabel: string, submit: DialogSubmit): void {
  $("dialog-kicker").textContent = kicker; $("dialog-title").textContent = title; $("dialog-fields").innerHTML = fields;
  $("dialog-submit").textContent = submitLabel; $("dialog-error").textContent = ""; dialogSubmit = submit;
  $<HTMLDialogElement>("dialog").showModal();
  $("dialog-fields").querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")?.focus();
}
function newProject(): void {
  dialog("Project", "Add a project", '<label>Project name<input name="name" maxlength="80" placeholder="My project" required /></label><label>Git URL <span class="optional">optional</span><input name="repository" maxlength="2048" placeholder="https://github.com/you/project.git" /></label><p class="field-hint">Leave the URL empty to start from a blank repository.</p>', "Create project", async values => {
    const created = await api<Workspace>("/workspaces", "POST", { name: values.get("name"), repository: values.get("repository") });
    projectId = created.id; await refresh(); notice("Project created. Add a task when ready.");
  });
}
function newTask(): void {
  const projects = state.workspaces.filter(item => item.kind === "primary" && item.state !== "discarded");
  if (!projects.length) { newProject(); return; }
  dialog("New task", "New task", `<label>Project<select name="project">${projects.map(item => `<option value="${item.id}" ${item.id === projectId ? "selected" : ""}>${html(item.name)}</option>`).join("")}</select></label><label>Task name<input name="name" maxlength="80" placeholder="Add pagination" required /></label><label>Instructions<textarea name="prompt" maxlength="20000" rows="5" placeholder="What should change? How should it be checked?" required></textarea></label><fieldset><legend>Approach</legend><label class="choice"><input type="radio" name="approach" value="one" checked /> One attempt</label><label class="choice"><input type="radio" name="approach" value="two" /> Compare two attempts</label></fieldset><label id="other-prompt" hidden>Second approach<textarea name="other" maxlength="20000" rows="4" placeholder="Describe the alternative approach."></textarea></label><p class="field-hint">Changes stay in isolated copies until you apply them.</p>`, "Start task", async values => {
    const id = String(values.get("project")), name = String(values.get("name")), prompt = String(values.get("prompt"));
    if (values.get("approach") === "two") {
      const other = String(values.get("other") ?? "").trim(); if (!other) throw new Error("Describe the second approach.");
      const copies = await api<Workspace[]>(`/workspaces/${id}/parallel`, "POST", { tasks: [{ name: `${name} · A`, prompt }, { name: `${name} · B`, prompt: other }] });
      await refresh(); const created = state.runs.find(item => item.workspaceId === copies[0].id); if (created) setSelection(created.id);
    } else {
      const result = await api<{ workspace: Workspace; run: AgentRun }>(`/workspaces/${id}/tasks`, "POST", { name, prompt, isolated: true });
      await refresh(); setSelection(result.run.id);
    }
  });
}
function continueTask(): void {
  const source = workspace(run()?.workspaceId ?? ""); if (!source) return;
  dialog("Continue", "Continue task", '<label>Instructions<textarea name="prompt" maxlength="20000" rows="5" placeholder="What should it do next?" required></textarea></label>', "Send instruction", async values => {
    const created = await api<AgentRun>(`/workspaces/${source.id}/runs`, "POST", { prompt: values.get("prompt") });
    await refresh(); setSelection(created.id);
  });
}
async function openReview(ids: string[]): Promise<void> {
  reviewIds = ids; screen = "review"; proposals.clear(); chosenFiles.clear(); detailKey = ""; renderDetail();
  await Promise.all(ids.map(async id => { try { proposals.set(id, await api<ChangeProposal>(`/workspaces/${id}/review`, "POST", {})); } catch (error) { notice((error as Error).message); } }));
  renderDetail();
}

$("project-options").addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-project]"); if (!button) return;
  projectId = button.dataset.project!; $<HTMLDetailsElement>("project-switcher").open = false;
  renderProjects(); renderList();
});
document.addEventListener("click", event => {
  const switcher = $<HTMLDetailsElement>("project-switcher");
  if (switcher.open && !switcher.contains(event.target as Node)) switcher.open = false;
});
$("project-switcher").addEventListener("keydown", event => {
  if (event.key === "Escape") { $<HTMLDetailsElement>("project-switcher").open = false; $<HTMLElement>("project-switcher").querySelector("summary")?.focus(); }
});
$("new-project").addEventListener("click", newProject);
$("new-task").addEventListener("click", newTask);
for (const name of ["open", "all"] as const) $(`filter-${name}`).addEventListener("click", () => { filter = name; renderList(); });
$("task-list").addEventListener("click", event => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "new-project") { newProject(); return; }
  if (action === "new-task") { newTask(); return; }
  const id = target.closest<HTMLElement>("[data-run]")?.dataset.run;
  if (id) setSelection(id);
});
$("detail-content").addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]"); if (!button) return;
  const action = button.dataset.action!, source = workspace(run()?.workspaceId ?? "");
  if (action === "back") { mobileDetailOpen = false; $("shell").classList.remove("show-detail"); return; }
  if (action === "activity") { screen = "activity"; detailKey = ""; renderDetail(); return; }
  if (action === "continue") { continueTask(); return; }
  if (action === "file") { chosenFiles.set(button.dataset.review!, Number(button.dataset.index)); detailKey = ""; renderDetail(); return; }
  if (action === "review" && source) { void runAction(() => openReview([source.id])); return; }
  if (action === "compare" && source && button.dataset.other) { void runAction(() => openReview([source.id, button.dataset.other!])); return; }
  if (action === "approve" || action === "decline") {
    button.disabled = true;
    void runAction(async () => { await api(`/runs/${selectedRunId}/approvals`, "POST", { requestId: button.dataset.request, accepted: action === "approve" }); await refresh(); }); return;
  }
  if (action === "cancel") {
    if (!confirm("Cancel this run? Its files will remain available for review.")) return;
    button.disabled = true; void runAction(async () => { await api(`/runs/${selectedRunId}/cancel`, "POST", {}); await refresh(); }); return;
  }
  if (action === "discard" && source) {
    if (!confirm("Discard this copy and its files? Task history will remain.")) return;
    button.disabled = true; void runAction(async () => { await api(`/workspaces/${source.id}`, "DELETE"); await refresh(); }); return;
  }
  if (action === "apply") {
    const proposal = proposals.get(button.dataset.review ?? ""); if (!proposal) return;
    if (!confirm("Apply every changed file to the primary project? This does not commit or push.")) return;
    button.disabled = true; void runAction(async () => {
      const applied = await api<ChangeProposal>(`/changes/${proposal.id}/apply`, "POST", {});
      proposal.appliedAt = applied.appliedAt; await refresh(); detailKey = ""; renderDetail(); notice("Changes applied to the project.");
    });
  }
});
$("dialog-fields").addEventListener("change", event => {
  const target = event.target as HTMLInputElement;
  if (target.name === "approach") {
    const two = target.value === "two"; const field = $("other-prompt"); field.hidden = !two;
    field.querySelector("textarea")!.required = two;
  }
});
$("dialog-form").addEventListener("submit", event => {
  event.preventDefault(); const submit = $<HTMLButtonElement>("dialog-submit"); submit.disabled = true;
  void dialogSubmit(new FormData($<HTMLFormElement>("dialog-form"))).then(() => $<HTMLDialogElement>("dialog").close()).catch(error => { $("dialog-error").textContent = (error as Error).message; }).finally(() => submit.disabled = false);
});
for (const id of ["close-dialog", "dialog-cancel"]) $(id).addEventListener("click", () => $<HTMLDialogElement>("dialog").close());
window.addEventListener("popstate", () => setSelection(new URL(location.href).searchParams.get("run") ?? ""));
window.setInterval(() => void runAction(refresh), 5000);
void runAction(async () => { await refresh(); connect(); });
