// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../ui/chat-markdown.js";

describe("chat Markdown", () => {
  it("renders prose, lists, tables, and fenced code with copy controls", () => {
    const element = document.createElement("div");
    renderMarkdown(element, "## Heading\n\n**Bold**\n\n- item\n\n```js\nconsole.log('<hello>')\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(element.querySelector("h2").textContent).toBe("Heading");
    expect(element.querySelector("strong").textContent).toBe("Bold");
    expect(element.querySelector("li").textContent).toBe("item");
    expect(element.querySelector("code").textContent).toContain("<hello>");
    expect(element.querySelector("button").textContent).toBe("Copy code");
    expect(element.querySelectorAll("td")).toHaveLength(2);
  });
  it("blocks scripts, remote images, inline handlers, SVG, and privileged navigation", () => {
    const element = document.createElement("div");
    renderMarkdown(element, '<img src="https://tracker.example/pixel" onerror="alert(1)"><svg onload="alert(1)"></svg><script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [file](file:///etc/passwd) [extension](chrome-extension://test/ui/options.html) [relative](options.html) [good](https://example.com/path)');
    expect(element.querySelector("img,svg,script,[onerror],[onload]")).toBeNull();
    const links = [...element.querySelectorAll("a[href]")];
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe("https://example.com/path");
    expect(links[0].rel).toBe("noopener noreferrer");
  });
});
