import { marked } from "./vendor/marked.js";
import DOMPurify from "./vendor/purify.js";

/** Treat both model output and pasted user text as untrusted. */
export function renderMarkdown(element, text) {
  const fragment = DOMPurify.sanitize(marked.parse(text, { breaks: true, async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "a", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "title", "start"],
  });
  for (const link of fragment.querySelectorAll("a")) {
    // No extension/file/javascript/data navigation, including relative links.
    if (!/^https?:\/\//i.test(link.getAttribute("href") || "")) link.removeAttribute("href");
    else { link.target = "_blank"; link.rel = "noopener noreferrer"; }
  }
  element.replaceChildren(fragment);
  for (const code of element.querySelectorAll("pre > code")) {
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "copy-code"; copy.textContent = "Copy code";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(code.textContent).then(() => { copy.textContent = "Copied"; })
        .catch(() => { copy.textContent = "Select code to copy"; });
    });
    code.parentElement.prepend(copy);
  }
}
