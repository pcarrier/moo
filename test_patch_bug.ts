import { patchText } from "./harness/src/core/patch";

// Test case: insertion at end of file with fuzzy matching
// This should match at position 3 (original.length)
const original = "a\nb\nc\n";
const diff = "@@ -1,2 +1,3 @@\n a\n b\n+inserted\n";

try {
  const result = patchText(original, diff);
  console.log("Result:", JSON.stringify(result));
} catch (e) {
  console.error("Error:", e.message);
}
