import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";

import { api, type WorkflowDefinitionSummary, type WorkflowRunInspection, type WorkflowRunSummary, type WorkflowStepRun } from "./api";
import type { Bag } from "./state";
import { BackToChatButton, EmptyState, HeaderIconButton, PageBody, PageHeader, PageShell } from "./PageChrome";
import { RefreshIcon } from "./icons";

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fieldName(field: any): string {
  return String(field?.name ?? field?.id ?? "").trim();
}

function fieldType(field: any): string {
  return String(field?.type ?? "text");
}

function statusClass(status: string | null | undefined) {
  return `status-${String(status || "unknown").replace(/[^a-z0-9_-]/gi, "-")}`;
}

function waitingStep(run: WorkflowRunInspection | null): WorkflowStepRun | null {
  return run?.steps.find((step) => step.status === "waiting") ?? null;
}

type InputField = { name: string; type: string; label: string; required: boolean; description?: string; options?: Array<{ label: string; value: string }>; defaultValue?: unknown };

function workflowSchema(workflow: WorkflowDefinitionSummary | null): any {
  const schema = workflow?.inputSchema;
  return schema && typeof schema === "object" ? schema as any : null;
}

function fieldLabel(name: string, schema: any): string {
  return String(schema?.title ?? name);
}

function inputFields(workflow: WorkflowDefinitionSummary | null): InputField[] {
  const schema = workflowSchema(workflow);
  if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(schema.properties).map(([name, raw]) => {
    const prop = raw && typeof raw === "object" ? raw as any : {};
    const type = Array.isArray(prop.enum) ? "select" : String(Array.isArray(prop.type) ? prop.type.find((item: unknown) => item !== "null") ?? "string" : prop.type ?? "string");
    return {
      name,
      type,
      label: fieldLabel(name, prop),
      required: required.has(name),
      description: typeof prop.description === "string" ? prop.description : undefined,
      options: Array.isArray(prop.enum) ? prop.enum.map((value: unknown) => ({ value: String(value), label: String(value) })) : undefined,
      defaultValue: prop.default,
    };
  });
}

function initialInput(workflow: WorkflowDefinitionSummary | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of inputFields(workflow)) if (field.defaultValue !== undefined) out[field.name] = field.defaultValue;
  return out;
}

function coerceInputField(field: InputField, value: FormDataEntryValue | null): unknown {
  if (field.type === "boolean") return value === "on";
  const text = String(value ?? "");
  if (!text && !field.required) return undefined;
  if (field.type === "number" || field.type === "integer") return Number(text || 0);
  if (field.type === "array" || field.type === "object") return text.trim() ? JSON.parse(text) : field.type === "array" ? [] : {};
  return text;
}

function setInputValue(root: Record<string, unknown>, name: string, value: unknown): void {
  const parts = name.split(".").filter(Boolean);
  if (!parts.length) return;
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    if (!cur[part] || typeof cur[part] !== "object" || Array.isArray(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]!] = value;
}

function formInput(workflow: WorkflowDefinitionSummary | null, form: HTMLFormElement): Record<string, unknown> {
  const data = new FormData(form);
  const fields = inputFields(workflow);
  if (!fields.length) return {};
  const out = initialInput(workflow);
  for (const field of fields) {
    const value = coerceInputField(field, data.get(field.name));
    if (value !== undefined) setInputValue(out, field.name, value);
  }
  return out;
}

function inputDefault(field: InputField): string {
  if (field.defaultValue === undefined) return "";
  if (field.type === "array" || field.type === "object") return pretty(field.defaultValue);
  return String(field.defaultValue);
}

function inputKind(field: InputField): string {
  if (field.type === "number" || field.type === "integer") return "number";
  return "text";
}

function WorkflowInputFields(props: { workflow: WorkflowDefinitionSummary }) {
  const fields = createMemo(() => inputFields(props.workflow));
  return (
    <Show when={fields().length} fallback={<div class="workflow-empty-note">No inputs declared.</div>}>
      <For each={fields()}>
        {(field) => (
          <label class="workflow-start-field">
            <span>{field.label}{field.required ? " *" : ""}</span>
            <Show when={field.description}>
              {(description) => <small>{description()}</small>}
            </Show>
            <Show
              when={field.type === "boolean"}
              fallback={
                <Show
                  when={field.type === "select"}
                  fallback={
                    <Show
                      when={field.type === "array" || field.type === "object"}
                      fallback={<input name={field.name} type={inputKind(field)} required={field.required} value={inputDefault(field)} />}
                    >
                      <textarea name={field.name} required={field.required} value={inputDefault(field)} spellcheck={false} />
                    </Show>
                  }
                >
                  <select name={field.name} required={field.required} value={inputDefault(field)}>
                    <option value="">{field.required ? "Select…" : "None"}</option>
                    <For each={field.options ?? []}>
                      {(option) => <option value={option.value}>{option.label}</option>}
                    </For>
                  </select>
                </Show>
              }
            >
              <input name={field.name} type="checkbox" checked={Boolean(field.defaultValue)} />
            </Show>
          </label>
        )}
      </For>
    </Show>
  );
}

export function WorkflowsView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;
  const [workflows, setWorkflows] = createSignal<WorkflowDefinitionSummary[]>([]);
  const [runs, setRuns] = createSignal<WorkflowRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = createSignal<string | null>(null);
  const [selectedRun, setSelectedRun] = createSignal<WorkflowRunInspection | null>(null);
  const [selectedStepPath, setSelectedStepPath] = createSignal<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const selectedWorkflow = createMemo(() => {
    const id = selectedWorkflowId();
    return workflows().find((workflow) => workflow.id === id) ?? workflows()[0] ?? null;
  });

  createEffect(() => {
    const list = workflows();
    const current = selectedWorkflowId();
    if (!list.length) {
      if (current) setSelectedWorkflowId(null);
      return;
    }
    if (!current || !list.some((workflow) => workflow.id === current)) setSelectedWorkflowId(list[0]!.id);
  });

  const selectedStep = createMemo(() => {
    const path = selectedStepPath();
    const run = selectedRun();
    if (!run) return null;
    return run.steps.find((step) => step.path === path) ?? waitingStep(run) ?? run.steps[run.steps.length - 1] ?? null;
  });

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const [workflowResult, runsResult] = await Promise.all([api.workflows.list(), api.workflows.runs()]);
      if (!workflowResult.ok) throw new Error(workflowResult.error.message);
      if (!runsResult.ok) throw new Error(runsResult.error.message);
      setWorkflows(workflowResult.value.workflows);
      setRuns(runsResult.value.runs);
      const current = selectedRunId();
      const next = current && runsResult.value.runs.some((run) => run.runId === current)
        ? current
        : runsResult.value.runs[0]?.runId ?? null;
      if (next) await inspectRun(next);
      else {
        setSelectedRunId(null);
        setSelectedRun(null);
        setSelectedStepPath(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function inspectRun(runId: string) {
    setSelectedRunId(runId);
    const result = await api.workflows.runs();
    if (result.ok) setRuns(result.value.runs);
    const inspected = await api.workflows.inspectRun(runId).catch(() => null);
    const value = inspected?.ok ? inspected.value.run : null;
    if (value) {
      setSelectedRun(value);
      setSelectedStepPath(value.currentStep ?? waitingStep(value)?.path ?? value.steps[value.steps.length - 1]?.path ?? null);
      return;
    }
    const fallback = await api.workflows.runs();
    if (!fallback.ok) return;
  }

  async function loadRun(runId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.workflows.inspectRun(runId);
      if (!result.ok) throw new Error(result.error.message);
      setSelectedRunId(runId);
      if (!result.value.run) throw new Error("workflow run not found");
      setSelectedRun(result.value.run);
      setSelectedStepPath(result.value.run.currentStep ?? waitingStep(result.value.run)?.path ?? result.value.run.steps[result.value.run.steps.length - 1]?.path ?? null);
      const runsResult = await api.workflows.runs();
      if (runsResult.ok) setRuns(runsResult.value.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startWorkflow(workflow: WorkflowDefinitionSummary, ev: SubmitEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = formInput(workflow, ev.currentTarget as HTMLFormElement);
      const result = await api.workflows.run(workflow.id, { input, autoResume: true });
      if (!result.ok) throw new Error(result.error.message);
      setSelectedRunId(result.value.run.runId);
      setSelectedRun(result.value.run);
      setSelectedStepPath(result.value.run.currentStep ?? waitingStep(result.value.run)?.path ?? result.value.run.steps[result.value.run.steps.length - 1]?.path ?? null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: () => Promise<{ ok: boolean; value?: { run: WorkflowRunInspection }; error?: { message: string } }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error?.message || "workflow action failed");
      if (result.value?.run) {
        setSelectedRunId(result.value.run.runId);
        setSelectedRun(result.value.run);
        setSelectedStepPath(result.value.run.currentStep ?? waitingStep(result.value.run)?.path ?? result.value.run.steps[result.value.run.steps.length - 1]?.path ?? null);
      }
      const runsResult = await api.workflows.runs();
      if (runsResult.ok) setRuns(runsResult.value.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function submitWaiting(ev: SubmitEvent) {
    ev.preventDefault();
    const run = selectedRun();
    const step = waitingStep(run);
    if (!run || !step) return;
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const fields = ((step.args as any)?.spec?.fields ?? []) as any[];
    const value: Record<string, unknown> = {};
    for (const field of fields) {
      const name = fieldName(field);
      if (!name) continue;
      const type = fieldType(field);
      if (type === "boolean") value[name] = data.get(name) === "on";
      else if (type === "number") value[name] = Number(data.get(name) ?? 0);
      else value[name] = String(data.get(name) ?? "");
    }
    void runAction(() => api.workflows.submit(run.runId, step.path, value));
  }

  onMount(() => { void refresh(); });

  return (
    <PageShell class="workflows-view" mainClass="workflows-main">
      <PageHeader
        bag={bag}
        title="Workflows"
        onToggleSidebar={props.onToggleSidebar || (() => {})}
        actions={
          <>
            <BackToChatButton bag={bag} />
            <HeaderIconButton title="refresh workflows" aria-label="refresh workflows" onClick={() => void refresh()}>
              <RefreshIcon />
            </HeaderIconButton>
          </>
        }
      />
      <PageBody class="workflows-body">
        <Show when={error()}>
          {(message) => <div class="workflow-error">{message()}</div>}
        </Show>
        <div class="workflow-grid">
          <section class="workflow-panel workflow-library">
            <header>
              <h2>Library</h2>
              <span>{workflows().length}</span>
            </header>
            <Show when={workflows().length} fallback={<EmptyState>no workflow definitions</EmptyState>}>
              <>
                <ul class="workflow-list">
                  <For each={workflows()}>
                    {(workflow) => (
                      <li>
                        <button
                          type="button"
                          class={workflow.id === selectedWorkflowId() ? "selected" : ""}
                          onClick={() => setSelectedWorkflowId(workflow.id)}
                        >
                          <strong>{workflow.title || workflow.id}</strong>
                          <code>{workflow.id}</code>
                          <span>{workflow.steps} steps</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={selectedWorkflow()}>
                  {(workflow) => (
                    <form class="workflow-start-form" onSubmit={(ev) => void startWorkflow(workflow(), ev)}>
                      <header>
                        <h3>Run {workflow().title || workflow().id}</h3>
                        <code>{workflow().id}</code>
                      </header>
                      <WorkflowInputFields workflow={workflow()} />
                      <button type="submit" disabled={busy()}>run</button>
                    </form>
                  )}
                </Show>
              </>
            </Show>
          </section>

          <section class="workflow-panel workflow-runs">
            <header>
              <h2>Runs</h2>
              <span>{runs().length}</span>
            </header>
            <Show when={runs().length} fallback={<EmptyState>no workflow runs</EmptyState>}>
              <ul class="workflow-run-list">
                <For each={runs()}>
                  {(run) => (
                    <li>
                      <button
                        type="button"
                        classList={{ selected: selectedRunId() === run.runId }}
                        onClick={() => void loadRun(run.runId)}
                      >
                        <span><strong>{run.workflowId}</strong> <code>{run.runId}</code></span>
                        <span class={`workflow-status ${statusClass(run.status)}`}>{run.status}</span>
                        <Show when={run.currentStep}><small>{run.currentStep}</small></Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <section class="workflow-panel workflow-run-detail">
            <Show when={selectedRun()} fallback={<EmptyState>select a run</EmptyState>} keyed>
              {(run) => (
                <>
                  <header>
                    <div>
                      <h2>{run.workflowId}</h2>
                      <code>{run.runId}</code>
                    </div>
                    <span class={`workflow-status ${statusClass(run.status)}`}>{run.status}</span>
                  </header>
                  <div class="workflow-actions">
                    <button type="button" disabled={busy()} onClick={() => void runAction(() => api.workflows.resume(run.runId))}>resume</button>
                    <button type="button" disabled={busy()} onClick={() => void runAction(() => api.workflows.retry(run.runId, { from: run.currentStep ?? null }))}>retry</button>
                    <button type="button" disabled={busy()} onClick={() => void runAction(() => api.workflows.fork(run.runId, { autoResume: false }))}>fork</button>
                    <button type="button" disabled={busy()} onClick={() => void runAction(() => api.workflows.cancel(run.runId))}>cancel</button>
                  </div>
                  <div class="workflow-diagram mermaid" data-mermaid-source={run.mermaid}>{run.mermaid}</div>

                  <Show when={waitingStep(run)} keyed>
                    {(step) => (
                      <form class="workflow-waiting-form" onSubmit={submitWaiting}>
                        <h3>{String((step.args as any)?.spec?.title ?? step.path)}</h3>
                        <Show when={(step.args as any)?.context}>
                          <pre>{pretty((step.args as any).context)}</pre>
                        </Show>
                        <For each={((step.args as any)?.spec?.fields ?? []) as any[]}>
                          {(field) => {
                            const name = fieldName(field);
                            const type = fieldType(field);
                            return (
                              <label>
                                <span>{String(field?.label ?? name)}</span>
                                <Show when={type === "textarea"} fallback={
                                  <Show when={type === "boolean"} fallback={<input name={name} type={type === "number" ? "number" : "text"} required={field?.required === true} />}>
                                    <input name={name} type="checkbox" />
                                  </Show>
                                }>
                                  <textarea name={name} required={field?.required === true} />
                                </Show>
                              </label>
                            );
                          }}
                        </For>
                        <button type="submit" disabled={busy()}>submit</button>
                      </form>
                    )}
                  </Show>

                  <div class="workflow-detail-columns">
                    <section>
                      <h3>Steps</h3>
                      <ul class="workflow-steps">
                        <For each={run.steps}>
                          {(step) => (
                            <li>
                              <button type="button" classList={{ selected: selectedStep()?.path === step.path }} onClick={() => setSelectedStepPath(step.path)}>
                                <span>{step.path}</span>
                                <span class={`workflow-status ${statusClass(step.status)}`}>{step.status}</span>
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </section>
                    <section>
                      <h3>State</h3>
                      <pre>{pretty(run.state)}</pre>
                      <Show when={selectedStep()} keyed>
                        {(step) => (
                          <>
                            <h3>Selected step</h3>
                            <pre>{pretty(step)}</pre>
                          </>
                        )}
                      </Show>
                    </section>
                  </div>
                </>
              )}
            </Show>
          </section>
        </div>
      </PageBody>
    </PageShell>
  );
}
