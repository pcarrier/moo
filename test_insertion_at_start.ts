import { patchText } from "./harness/src/core/patch";

// Insert at the very beginning (pure insertion, oldCount = 0)
// @@ -1,0 +1,2 @@ means: starting at line 1, insert 2 lines
const original = "a\n";
const diff = "@@ -1,0 +1,3 @@\n+inserted_line1\n+inserted_line2\n a\n";

try {
  const result = patchText(original, diff);
  console.log("Result:", JSON.stringify(result));
  console.log("Expected: 'inserted_line1\\ninserted_line2\\na\\n'");
} catch (e) {
  console.error("Error:", e.message);
}
