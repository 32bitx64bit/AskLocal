import { api } from "./api.js";

export function renderMarkdownInto(container, markdown) {
  container.textContent = "";
  const fragment = renderMarkdown(markdown);
  container.appendChild(fragment);
}
export function renderMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```(\S*)?\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      fragment.appendChild(createCodeBlock(codeLines.join("\n"), fence[1] || ""));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const element = document.createElement(`h${level}`);
      appendInlineMarkdown(element, heading[2].trim());
      fragment.appendChild(element);
      index += 1;
      continue;
    }

    // Thematic break — must be tested before lists so "- - -" becomes an <hr>,
    // not a list item, matching GFM precedence.
    if (isHorizontalRuleLine(line)) {
      fragment.appendChild(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      quote.appendChild(renderMarkdown(quoteLines.join("\n")));
      fragment.appendChild(quote);
      continue;
    }

    const listKind = getMarkdownListKind(line);
    if (listKind) {
      const list = document.createElement(listKind === "ordered" ? "ol" : "ul");
      while (index < lines.length && getMarkdownListKind(lines[index]) === listKind) {
        const itemText = lines[index].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "");
        const item = document.createElement("li");
        appendInlineMarkdown(item, itemText.trim());
        list.appendChild(item);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    if (isTableStart(lines, index)) {
      const headerCells = splitTableRow(line);
      const alignments = parseTableAlignments(lines[index + 1]);
      index += 2;
      const rows = [];
      while (index < lines.length && isTableRowLine(lines[index]) && !isTableSeparatorRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      fragment.appendChild(createMarkdownTable(headerCells, alignments, rows));
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length
      && lines[index].trim()
      && !/^\s*```/.test(lines[index])
      && !/^(#{1,6})\s+/.test(lines[index])
      && !/^\s*>/.test(lines[index])
      && !isHorizontalRuleLine(lines[index])
      && !isTableStart(lines, index)
      && !getMarkdownListKind(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (!paragraphLines.length) {
      // The line looked like a block start to the tests above but its dedicated branch
      // did not consume it (e.g. a partial "# " or "```js x" mid-stream). Without this,
      // index never advances and the loop spins forever, freezing the page.
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "));
    fragment.appendChild(paragraph);
  }

  if (!fragment.childNodes.length) {
    fragment.appendChild(document.createTextNode(""));
  }
  return fragment;
}
export function getMarkdownListKind(line) {
  if (/^\s{0,3}[-*+]\s+/.test(line)) return "unordered";
  if (/^\s{0,3}\d+[.)]\s+/.test(line)) return "ordered";
  return "";
}
export function isHorizontalRuleLine(line) {
  return /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(String(line || ""));
}
export function isTableStart(lines, index) {
  return isTableRowLine(lines[index]) && isTableSeparatorRow(lines[index + 1]);
}
export function isTableRowLine(line) {
  const text = String(line || "");
  return text.includes("|") && Boolean(text.trim());
}
export function isTableSeparatorRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("-") || !/^[|\s:-]+$/.test(trimmed)) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}
export function splitTableRow(line) {
  let trimmed = String(line || "").trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
export function parseTableAlignments(line) {
  return splitTableRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "";
  });
}
export function createMarkdownTable(headerCells, alignments, rows) {
  const wrapper = document.createElement("div");
  wrapper.className = "md-table";
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headerCells.forEach((cell, cellIndex) => {
    const th = document.createElement("th");
    if (alignments[cellIndex]) th.style.textAlign = alignments[cellIndex];
    appendInlineMarkdown(th, cell);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((cells) => {
    const tr = document.createElement("tr");
    headerCells.forEach((_, cellIndex) => {
      const td = document.createElement("td");
      if (alignments[cellIndex]) td.style.textAlign = alignments[cellIndex];
      appendInlineMarkdown(td, cells[cellIndex] ?? "");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  wrapper.appendChild(table);
  return wrapper;
}
export function createCodeBlock(code, language) {
  const pre = document.createElement("pre");
  const codeElement = document.createElement("code");
  if (language) codeElement.dataset.language = language;
  codeElement.textContent = code;
  pre.appendChild(codeElement);
  return pre;
}
export function appendInlineMarkdown(parent, text) {
  const source = String(text ?? "");
  // Alternation order matters: markdown links/images first so a bare-URL match
  // can never eat the inside of [text](url); bare URLs last as the fallback.
  const pattern = /(!?\[[^\]]*\]\(https?:\/\/[^)\s]+[^)]*\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    }
    parent.appendChild(renderInlineToken(match[0]));
    cursor = match.index + match[0].length;
  }

  if (cursor < source.length) {
    parent.appendChild(document.createTextNode(source.slice(cursor)));
  }
}
export function renderInlineToken(token) {
  // Images become labeled links: the panel never hot-loads external images, but
  // the reference stays clickable instead of showing raw ![...](...) syntax.
  const image = token.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+[^)]*)\)$/);
  if (image) {
    return createMarkdownAnchor(image[2], image[1] ? `🖼 ${image[1]}` : "🖼 image");
  }

  const link = token.match(/^\[([^\]]*)\]\((https?:\/\/[^)\s]+[^)]*)\)$/);
  if (link) {
    return createMarkdownAnchor(link[2], link[1] || link[2]);
  }

  const autolink = token.match(/^<(https?:\/\/[^>\s]+)>$/);
  if (autolink) {
    return createMarkdownAnchor(autolink[1], autolink[1]);
  }

  if (/^https?:\/\//.test(token)) {
    return createMarkdownAnchor(token, token);
  }

  if (token.startsWith("~~") && token.endsWith("~~")) {
    const del = document.createElement("del");
    appendInlineMarkdown(del, token.slice(2, -2));
    return del;
  }

  if (token.startsWith("`") && token.endsWith("`")) {
    const code = document.createElement("code");
    code.textContent = token.slice(1, -1);
    return code;
  }

  if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
    const strong = document.createElement("strong");
    appendInlineMarkdown(strong, token.slice(2, -2));
    return strong;
  }

  if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) {
    const em = document.createElement("em");
    appendInlineMarkdown(em, token.slice(1, -1));
    return em;
  }

  return document.createTextNode(token);
}
export function createMarkdownAnchor(url, label) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer nofollow";
  anchor.textContent = label;
  return anchor;
}

