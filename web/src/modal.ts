export const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';

export function hasOpenModalDialog(
  root: Pick<ParentNode, "querySelector"> = document,
): boolean {
  return root.querySelector(MODAL_DIALOG_SELECTOR) !== null;
}
