import { describe, expect, test } from "bun:test";
import { renderMarkdown, renderUserMessage } from "./markdown";

describe("renderUserMessage", () => {
  test("preserves single newlines in user input", () => {
    expect(renderUserMessage("alpha\nbeta\ngamma")).toBe("<p>alpha<br>beta<br>gamma</p>\n");
  });

  test("does not change assistant markdown soft line breaks", () => {
    expect(renderMarkdown("alpha\nbeta")).toBe("<p>alpha\nbeta</p>\n");
  });

  test("renders mermaid fences as native diagram containers", () => {
    expect(renderMarkdown("```mermaid\ngraph TD\n  A-->B\n```"))
      .toBe("<div class=\"mermaid\" data-mermaid-source=\"graph TD\n  A--&gt;B\">graph TD\n  A--&gt;B</div>\n");
  });

  test("escapes mermaid diagram source until the client renderer runs", () => {
    expect(renderMarkdown("```mermaid\ngraph TD\n  A[<script>]-->B\n```"))
      .toBe(
        "<div class=\"mermaid\" data-mermaid-source=\"graph TD\n  A[&lt;script&gt;]--&gt;B\">" +
        "graph TD\n  A[&lt;script&gt;]--&gt;B</div>\n",
      );
  });
});
