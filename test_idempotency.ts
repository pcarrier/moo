import { patchText } from "./harness/src/core/patch";

const original = "a\nb\nc\n";
const diff = "@@ -1,3 +1,4 @@\n a\n b\n+inserted\n c\n";

const result1 = patchText(original, diff);
console.log("After patch 1:", JSON.stringify(result1));

try {
  // Try applying the same patch again - should this work or fail?
  const result2 = patchText(result1, diff);
  console.log("After patch 2:", JSON.stringify(result2));
} catch (e) {
  console.error("Patch 2 failed (expected):", e.message);
}
