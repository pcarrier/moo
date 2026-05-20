export function LoadingDots(props: { class?: string; label?: string }) {
  const className = () => props.class ? `loading-dots ${props.class}` : "loading-dots";
  const labeled = () => !!props.label;
  const phaseDelay = `-${Date.now() % 1200}ms`;

  return (
    <span
      class={className()}
      style={{ "--loading-dot-phase-delay": phaseDelay }}
      role={labeled() ? "status" : undefined}
      aria-label={props.label}
      aria-hidden={labeled() ? undefined : "true"}
    >
      <span class="loading-dot" />
      <span class="loading-dot" />
      <span class="loading-dot" />
    </span>
  );
}
