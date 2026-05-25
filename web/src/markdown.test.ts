import { describe, expect, test } from "bun:test";
import { renderMarkdown, renderMarkdownInline, renderMarkdownWithBreaks, renderUserMessage } from "./markdown";

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

  test("escapes raw HTML in default markdown output", () => {
    expect(renderMarkdown('hello <img src=x onerror="alert(1)"> <script>alert(2)</script>'))
      .toBe('<p>hello &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &lt;script&gt;alert(2)&lt;/script&gt;</p>\n');
    expect(renderMarkdownInline('<span onclick="alert(1)">x</span>'))
      .toBe('&lt;span onclick=&quot;alert(1)&quot;&gt;x&lt;/span&gt;');
    expect(renderMarkdownWithBreaks('alpha\n<section onclick="alert(1)">beta</section>'))
      .toBe('<p>alpha</p>\n&lt;section onclick=&quot;alert(1)&quot;&gt;beta&lt;/section&gt;');
  });

  test("renders unsafe markdown link and image protocols as inert attributes", () => {
    expect(renderMarkdown('[bad](javascript:alert(1)) ![x](data:text/html,evil)'))
      .toBe('<p><a href="">bad</a> <img src="" alt="x"></p>\n');
    expect(renderMarkdown('[bad](//evil.test/path) [ok](https://example.test/path)'))
      .toBe('<p><a href="">bad</a> <a href="https://example.test/path" target="_blank" rel="noopener noreferrer">ok</a></p>\n');
  });

  test("opens external markdown links in new tabs", () => {
    expect(renderMarkdown('[external](https://example.test/path) [email](mailto:test@example.test) [relative](docs/readme.md)'))
      .toBe('<p><a href="https://example.test/path" target="_blank" rel="noopener noreferrer">external</a> <a href="mailto:test@example.test" target="_blank" rel="noopener noreferrer">email</a> <a href="docs/readme.md">relative</a></p>\n');
    expect(renderMarkdownInline('see https://example.test/path'))
      .toBe('see <a href="https://example.test/path" target="_blank" rel="noopener noreferrer">https://example.test/path</a>');
  });

  test("does not add hard newline markers to code block lines", () => {
    expect(renderMarkdown("```ts\nconst alpha = 1;\nconst beta = 2;\n```"))
      .toBe('<pre><code class="language-ts"><span class="token keyword">const</span> alpha <span class="token operator">=</span> <span class="token number">1</span><span class="token punctuation">;</span>\n<span class="token keyword">const</span> beta <span class="token operator">=</span> <span class="token number">2</span><span class="token punctuation">;</span></code></pre>\n');
  });

  test("renders mermaid fences as native diagram containers", () => {
    expect(renderMarkdown("```mermaid\ngraph TD\n  A-->B\n```"))
      .toBe("<div class=\"mermaid\" data-mermaid-source=\"graph TD\n  A--&gt;B\">graph TD\n  A--&gt;B</div>\n");
  });


  test("marks unclosed mermaid fences as partial while streaming", () => {
    expect(renderMarkdown("```mermaid\ngraph TD\n  A-->B"))
      .toBe("<div class=\"mermaid\" data-mermaid-source=\"graph TD\n  A--&gt;B\" data-mermaid-partial=\"true\">graph TD\n  A--&gt;B</div>\n");
    expect(renderMarkdown("```mermaid\ngraph TD\n  A-->B\n```"))
      .not.toContain("data-mermaid-partial");
  });

  test("escapes mermaid diagram source until the client renderer runs", () => {
    expect(renderMarkdown("```mermaid\ngraph TD\n  A[<script>]-->B\n```"))
      .toBe(
        "<div class=\"mermaid\" data-mermaid-source=\"graph TD\n  A[&lt;script&gt;]--&gt;B\">" +
        "graph TD\n  A[&lt;script&gt;]--&gt;B</div>\n",
      );
  });
});
