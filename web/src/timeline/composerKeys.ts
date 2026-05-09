export function shouldApplyComposerAutocompleteKey(
  e: Pick<KeyboardEvent, "key">,
): boolean {
  return e.key === "Tab";
}
