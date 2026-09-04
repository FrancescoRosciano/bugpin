/**
 * Minimal Markdown → HTML for the report screenshot. Covers exactly what
 * lib/export.js emits in report.md — headings, bullet and numbered lists,
 * fenced code, inline code, bold, italic lines and images — and nothing else.
 * This is a preview for docs, never part of the extension.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/** Inline pass, run on already-escaped text: image, code, bold, italic. */
function inline(text) {
  return escapeHtml(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${src}" />`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^-\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;

/** @returns {string} a standalone HTML document */
export function renderMarkdown(md) {
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let inCode = false;
  let code = [];

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const openList = (tag) => {
    if (list !== tag) {
      closeList();
      out.push(`<${tag}>`);
      list = tag;
    }
  };

  for (const line of md.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
      } else {
        closeList();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      openList('ul');
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      openList('ol');
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  closeList();

  return `<!doctype html><html><head><meta charset="utf-8"><title>report.md</title><style>
    body { max-width: 820px; margin: 0 auto; padding: 28px 32px 60px;
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f1115; background: #fff; -webkit-font-smoothing: antialiased; }
    h1 { font-size: 24px; letter-spacing: -0.02em; margin: 0 0 16px; }
    h2 { font-size: 17px; letter-spacing: -0.01em; margin: 28px 0 10px;
      padding-bottom: 6px; border-bottom: 1px solid #e4e6eb; }
    h3 { font-size: 15px; margin: 22px 0 8px; }
    ul, ol { margin: 0 0 12px; padding-left: 22px; }
    li { margin-bottom: 3px; }
    p { margin: 0 0 12px; }
    code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #f2f3f5; border-radius: 4px; padding: 1px 4px; }
    pre { background: #f7f8fa; border: 1px solid #e4e6eb; border-radius: 8px;
      padding: 12px 14px; overflow-x: hidden; }
    pre code { background: none; padding: 0; white-space: pre-wrap; word-break: break-all; }
    img { display: block; max-width: 340px; margin: 8px 0 4px;
      border: 1px solid #e4e6eb; border-radius: 6px; }
    strong { font-weight: 600; }
  </style></head><body>${out.join('\n')}</body></html>`;
}
