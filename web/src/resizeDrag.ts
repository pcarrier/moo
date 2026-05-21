import { onCleanup } from "solid-js";

export function installPointerResize(
  handle: HTMLElement,
  options: {
    cursor: string;
    onStart: (event: PointerEvent) => boolean | void;
    onMove: (event: PointerEvent) => void;
    onEnd?: () => void;
  },
) {
  let dragging = false;
  let pointerId: number | null = null;
  let previousUserSelect = "";
  let previousCursor = "";

  const restoreBodyStyles = () => {
    document.body.style.userSelect = previousUserSelect;
    document.body.style.cursor = previousCursor;
  };

  const stop = (event?: PointerEvent) => {
    if (!dragging) return;
    if (event && pointerId !== null && event.pointerId !== pointerId) return;
    const activePointerId = pointerId;
    dragging = false;
    pointerId = null;
    if (
      activePointerId !== null &&
      handle.hasPointerCapture?.(activePointerId)
    ) {
      try {
        handle.releasePointerCapture(activePointerId);
      } catch {
        /* The browser may already have released capture. */
      }
    }
    restoreBodyStyles();
    options.onEnd?.();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (dragging || !event.isPrimary || event.button !== 0) return;
    if (options.onStart(event) === false) return;
    dragging = true;
    pointerId = event.pointerId;
    previousUserSelect = document.body.style.userSelect;
    previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = options.cursor;
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging || pointerId !== event.pointerId) return;
    options.onMove(event);
    event.preventDefault();
  };

  const onPointerUp = (event: PointerEvent) => {
    stop(event);
    event.preventDefault();
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);
  handle.addEventListener("lostpointercapture", onPointerUp);

  onCleanup(() => {
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerUp);
    handle.removeEventListener("pointercancel", onPointerUp);
    handle.removeEventListener("lostpointercapture", onPointerUp);
    stop();
  });
}
