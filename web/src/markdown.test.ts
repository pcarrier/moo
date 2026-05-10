import { describe, expect, test } from "bun:test";
import { renderMarkdown, renderUserMessage } from "./markdown";

describe("renderUserMessage", () => {
  test("preserves single newlines in user input", () => {
    expect(renderUserMessage("alpha\nbeta\ngamma")).toBe("alpha<br>\nbeta<br>\ngamma");
  });


  test("preserves blank lines in user input", () => {
    expect(renderUserMessage("alpha\n\nbeta")).toBe("alpha<br>\n<br>\nbeta");
  });

  test("preserves newlines around markdown blocks in user input", () => {
    expect(renderUserMessage("# title\nbody")).toBe("# title<br>\nbody");
    expect(renderUserMessage("**bold**\n_text_")).toBe("<strong>bold</strong><br>\n<em>text</em>");
  });

  test("does not change assistant markdown soft line breaks", () => {
    expect(renderMarkdown("alpha\nbeta")).toBe("<p>alpha\nbeta</p>\n");
  });

  test("does not add hard newline markers to code block lines", () => {
    expect(renderMarkdown("```ts\nconst alpha = 1;\nconst beta = 2;\n```"))
      .toBe('<pre><code class="language-ts"><span class="token keyword">const</span> alpha <span class="token operator">=</span> <span class="token number">1</span><span class="token punctuation">;</span>\n<span class="token keyword">const</span> beta <span class="token operator">=</span> <span class="token number">2</span><span class="token punctuation">;</span></code></pre>\n');
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
