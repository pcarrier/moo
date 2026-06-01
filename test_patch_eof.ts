import { patchText } from "./harness/src/core/patch";

// Test: insertion at actual EOF with fuzzy matching required
// Hunk says lines 1-2, but file has lines 1-3, so fuzzy should kick in
const original = "line1\nline2\nline3\n";

// This hunk expects lines at positions 0-1 (1-indexed: 1-2)
// But the actual content matching "line1\nline2" is at 0-1 in the file
// So it should work at 0
const diff = "@@ -1,2 +1,3 @@\n line1\n line2\n+inserted\n";

try {
  const result = patchText(original, diff);
  console.log("Result OK:", JSON.stringify(result));
} catch (e) {
  console.error("Error:", e.message);
}

// Test: insertion at EOF where the hunk context doesn't exist
// This should use fuzzy matching and find the lines
const original2 = "a\nb\nc\n";
const diff2 = "@@ -3,1 +3,2 @@\n c\n+newline\n";
try {
  const result2 = patchText(original2, diff2);
  console.log("Result2 OK:", JSON.stringify(result2));
} catch (e) {
  console.error("Error2:", e.message);
}
