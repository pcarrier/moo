import { For, Show, createMemo, createSignal, onMount } from "solid-js";

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

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  return trimmed ? JSON.parse(trimmed) : {};
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

export function WorkflowsView(props: { bag: Bag; onToggleSidebar?: () => void }) {
  const { bag } = props;
  const [workflows, setWorkflows] = createSignal<WorkflowDefinitionSummary[]>([]);
  const [runs, setRuns] = createSignal<WorkflowRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = createSignal<string | null>(null);
  const [selectedRun, setSelectedRun] = createSignal<WorkflowRunInspection | null>(null);
  const [selectedStepPath, setSelectedStepPath] = createSignal<string | null>(null);
  const [inputDraft, setInputDraft] = createSignal("{}");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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

  async function startWorkflow(workflow: WorkflowDefinitionSummary) {
    setBusy(true);
    setError(null);
    try {
      const input = parseJson(inputDraft());
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
            <label class="workflow-input-label">
              input JSON
              <textarea value={inputDraft()} onInput={(ev) => setInputDraft(ev.currentTarget.value)} spellcheck={false} />
            </label>
            <Show when={workflows().length} fallback={<EmptyState>no workflow definitions</EmptyState>}>
              <ul class="workflow-list">
                <For each={workflows()}>
                  {(workflow) => (
                    <li>
                      <div>
                        <strong>{workflow.title || workflow.id}</strong>
                        <code>{workflow.id}</code>
                        <span>{workflow.steps} steps</span>
                      </div>
                      <button type="button" disabled={busy()} onClick={() => void startWorkflow(workflow)}>run</button>
                    </li>
                  )}
                </For>
              </ul>
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
