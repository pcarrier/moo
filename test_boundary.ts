import { patchText } from "./harness/src/core/patch";

// Test: pure insertion hunk (no source lines, only additions) at EOF
// sourceLineCount = 0, so fuzzy search uses special path at line 618-620
// The hunk has no "-" or " " prefixed lines, only "+" lines
const original = "a\nb\n";
const diff = "@@ -3,0 +3,2 @@\n+c\n+d\n";

try {
  const result = patchText(original, diff);
  console.log("Result:", JSON.stringify(result));
} catch (e) {
  console.error("Error:", e.message);
}
