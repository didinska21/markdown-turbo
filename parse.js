// markdown-turbo: a dependency-free Markdown renderer whose output matches
// marked 18.1.3 (default options: GFM on, breaks off) byte for byte, written
// from the CommonMark 0.31.2 and GFM 0.29 specifications.
//
// The parser runs in two phases, like most Markdown engines: a block phase
// that splits the document into block-level tokens (collecting link reference
// definitions on the way), and an inline phase that parses the text of each
// block into emphasis, links, code spans and friends. No state survives a
// parse() call: everything below is allocated per call.

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const PUNCT_RE = /[\p{P}\p{S}]/u;

function isPunct(ch) {
  if (ch === undefined || ch === '') return false;
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return ASCII_PUNCT.has(ch);
  return PUNCT_RE.test(ch);
}

function isWs(ch) {
  // Start/end of the inline string count as whitespace for flanking rules.
  return ch === undefined || ch === '' || ch === ' ' || ch === '\t' || ch === '\n' ||
    ch === '\r' || ch === '\v' || ch === '\f' || /\s/.test(ch);
}

// ---------------------------------------------------------------------------
// HTML escaping (marked's two flavours)
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// An ampersand that begins something shaped like a character reference
// (&#123; / &#x1F600; / &name;) is left alone by the non-encoding escape.
const ENTITY_SHAPE = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/;

/** Escape text the way marked escapes running text: entities pass through. */
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      if (ENTITY_SHAPE.test(s.slice(i, i + 64))) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (ch === '<' || ch === '>' || ch === '"' || ch === "'") {
      out += s.slice(start, i) + ESCAPES[ch];
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/** Escape code (spans and blocks): every special character is encoded. */
function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const rep = ESCAPES[s[i]];
    if (rep !== undefined) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------------------
// Character references in text
// ---------------------------------------------------------------------------

// marked decodes numeric character references in running text to the actual
// character (which is then escaped again on output if it needs it); named
// references are left as written. A reference whose value is not a usable
// code point is left as written too.
function decodeNumericEntity(s, i) {
  // s[i] === '&', s[i + 1] === '#'
  let j = i + 2;
  let value;
  if (s[j] === 'x' || s[j] === 'X') {
    j++;
    const start = j;
    while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
    if (j === start || s[j] !== ';') return null;
    value = parseInt(s.slice(start, j), 16);
  } else {
    const start = j;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j === start || s[j] !== ';') return null;
    value = parseInt(s.slice(start, j), 10);
  }
  if (value === 0 || (value >= 0xd800 && value <= 0xdfff)) {
    return { text: '\uFFFD', end: j + 1 };
  }
  if (value > 0x10ffff) return null;
  return { text: String.fromCodePoint(value), end: j + 1 };
}

/** Resolve backslash escapes of ASCII punctuation in a destination/title. */
function unescapeString(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

/** marked's href cleaning: encodeURI, with stray % un-escaped; null on error. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%')
      .replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  } catch {
    return null;
  }
}

/** The key a link label is stored and looked up under. */
function normalizeLabel(label) {
  // Unicode case folding, as far as marked applies it: lowercasing plus
  // the sharp-s fold (ß and ẞ both fold to ss, matching SS).
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// ---------------------------------------------------------------------------
// Lines and indentation. Columns count a tab as advancing to the next
// multiple of 4, as the spec requires.
// ---------------------------------------------------------------------------

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/** Columns of leading whitespace, and the index just past it. */
function leadingWs(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col += 1; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, end: i };
}

/**
 * The substring of `line` starting at column `cols`, where every character
 * occupies one column except a tab, which advances to the next multiple
 * of 4. A tab straddling the boundary is replaced by its remaining spaces.
 * Used for a list item's first line, whose marker occupies real columns.
 */
function sliceFromCol(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const ch = line[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else return ' '.repeat(col + w - cols) + line.slice(i + 1);
    } else { col += 1; i++; }
  }
  return line.slice(i);
}

/** Expand a whitespace run starting at index i (column col) to spaces. */
function expandWsRun(line, i, col) {
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; i++; }
    else {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    }
  }
  return out + line.slice(i);
}

/**
 * Slice a line from column `cols` the way marked's container stripping
 * behaves: characters (markers included) count one column each, tabs count
 * to the next multiple of 4, and when the cut falls inside the leading
 * whitespace run, the remainder of that run is expanded to spaces using
 * the original column widths. The rest of the line is verbatim.
 */
function sliceExpanded(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const ch = line[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else {
        let out = ' '.repeat(col + w - cols);
        col += w;
        i++;
        return out + expandWsRun(line, i, col);
      }
    } else {
      col++;
      i++;
      if (col === cols && ch !== ' ' && ch !== '\t') return line.slice(i);
    }
  }
  if (i >= line.length) return '';
  if ((line[i] === ' ' || line[i] === '\t') && i > 0 &&
      (line[i - 1] === ' ' || line[i - 1] === '\t')) {
    return expandWsRun(line, i, col);
  }
  return line.slice(i);
}

/**
 * Remove up to `cols` columns of indentation from a line, the way the
 * fence tokenizer strips its own indent: a tab is always removed as a
 * whole character, even when it straddles the boundary.
 */
function stripColsTabWhole(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const ch = line[i];
    if (ch === ' ') { col += 1; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return line.slice(i);
}

/**
 * Remove up to `cols` columns of indentation from a line. A tab that
 * straddles the boundary is replaced by the spaces that remain of it.
 */
function stripCols(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const ch = line[i];
    if (ch === ' ') { col += 1; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else return ' '.repeat(col + w - cols) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// ---------------------------------------------------------------------------
// Block-level helpers
// ---------------------------------------------------------------------------

// Count how many characters a run of backticks/tildes at position p has.
function fenceRun(s, p, ch) {
  let n = 0;
  while (s[p + n] === ch) n++;
  return n;
}

// Try to read a link destination starting at s[p] (after leading whitespace
// handling by caller). Returns { dest, end } or null. allowNewline: whether
// whitespace runs may contain a newline (true for inline links).
function scanLinkDest(s, p, allowNewline) {
  // skip whitespace
  let i = p;
  let nl = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\n') { nl++; i++; continue; }
    break;
  }
  if (nl > 1 || (nl === 1 && !allowNewline)) return null;
  if (i >= s.length) return null;
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length) { out += c + s[j + 1]; j += 2; continue; }
      if (c === '>') return { dest: out, end: j + 1, angle: true };
      if (c === '<' || c === '\n') return null;
      out += c; j++;
    }
    return null;
  }
  // bare destination: balanced parens, no spaces/control
  let depth = 0;
  let j = i;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ASCII_PUNCT.has(s[j + 1])) { out += c + s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
    out += c; j++;
  }
  if (j === i) return null; // empty bare dest not allowed here (caller handles <>)
  return { dest: out, end: j, angle: false };
}

// Try to read a link title at s[p] (whitespace already skipped by caller is
// NOT assumed; this skips spaces/tabs and optionally one newline).
// Returns { title, end } or null.
function scanLinkTitle(s, p, allowNewline) {
  let i = p;
  let nl = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\n') { nl++; i++; continue; }
    break;
  }
  if (nl > 1 || (nl === 1 && !allowNewline)) return null;
  if (i >= s.length) return null;
  const open = s[i];
  let close;
  if (open === '"') close = '"';
  else if (open === "'") close = "'";
  else if (open === '(') close = ')';
  else return null;
  let j = i + 1;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) { out += c + s[j + 1]; j += 2; continue; }
    if (c === close) {
      if (open === '(' && c === '(') return null;
      return { title: out, end: j + 1 };
    }
    if (open === '(' && c === '(') return null;
    out += c; j++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------
// Attempt to parse a definition starting at lines[i]. Joins up to 6 lines.
// Returns { label, href(raw dest), title(raw|null), linesUsed } or null.
function tryParseDef(lines, i, end) {
  // Build a working string from up to 6 lines starting at i, tracking for
  // each line its span. We parse char by char over the joined text.
  const maxLines = Math.min(end, i + 6);
  let s = '';
  const lineStart = [0];
  for (let k = i; k < maxLines; k++) {
    if (k > i && isBlankLine(lines[k])) break; // a def never spans a blank line
    if (k > i) { s += '\n'; lineStart.push(s.length); }
    s += lines[k];
  }
  // indent up to 3
  let p = 0;
  let cols = 0;
  while (p < s.length && cols < 3 && s[p] === ' ') { p++; cols++; }
  if (s[p] === '\t') p++;
  if (s[p] !== '[') return null;
  // scan the label: it ends at the first unescaped ']' and may not contain
  // an unescaped '[' (marked's definition grammar is that strict)
  let j = p + 1;
  let label = '';
  let closed = false;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) { label += c + s[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { closed = true; break; }
    label += c; j++;
  }
  if (!closed || j >= s.length) return null;
  if (label.trim() === '') return null;
  if (s[j + 1] !== ':') return null;
  // whitespace after colon: spaces/tabs and at most one newline
  let q = j + 2;
  let nl = 0;
  let lastNlLine = -1;
  while (q < s.length) {
    const c = s[q];
    if (c === ' ' || c === '\t') { q++; continue; }
    if (c === '\n') {
      nl++; if (nl > 1) return null;
      lastNlLine = q; q++; continue;
    }
    break;
  }
  if (q >= s.length) return null;
  // destination: scanLinkDest skips the whitespace itself (at most one
  // newline is allowed there, enforced by the count above and its own).
  const dd = scanLinkDest(s, j + 2, true);
  if (!dd) return null;
  const dest = dd.dest;
  let title = null;
  let usedEndPos = dd.end;
  // After the destination: rest of the current line.
  // Determine which line dd.end falls on.
  const lineOf = (pos) => {
    let li = 0;
    for (let t = 1; t < lineStart.length; t++) {
      if (lineStart[t] <= pos) li = t; else break;
    }
    return li;
  };
  const destLine = lineOf(dd.end - 1);
  // remainder of dest line
  let r = dd.end;
  let restBlank = true;
  while (r < s.length && s[r] !== '\n') {
    if (s[r] !== ' ' && s[r] !== '\t') { restBlank = false; break; }
    r++;
  }
  if (restBlank) {
    // definition may end here, OR a title may follow on the NEXT line.
    const nextLineIdx = destLine + 1;
    if (nextLineIdx < lineStart.length) {
      const t = scanLinkTitle(s, lineStart[nextLineIdx], false);
      if (t) {
        // title found on next line: rest of that line must be blank
        let r2 = t.end;
        let ok = true;
        while (r2 < s.length && s[r2] !== '\n') {
          if (s[r2] !== ' ' && s[r2] !== '\t') { ok = false; break; }
          r2++;
        }
        if (ok) {
          title = t.title;
          usedEndPos = t.end;
        }
        // junk after a next-line title: the def stands without the title
        // and the title line stays unconsumed (cm-210)
      }
      // if no title parses, def ends at dest line (usedEndPos stays dd.end)
    }
  } else {
    // same-line title: must be separated from the destination by
    // whitespace (cm-201), parse, and be followed by blank rest
    let wsp = dd.end;
    while (wsp < s.length && (s[wsp] === ' ' || s[wsp] === '\t')) wsp++;
    if (wsp === dd.end) return null;
    const t = scanLinkTitle(s, dd.end, false);
    if (!t) return null;
    let r2 = t.end;
    while (r2 < s.length && s[r2] !== '\n') {
      if (s[r2] !== ' ' && s[r2] !== '\t') return null;
      r2++;
    }
    title = t.title;
    usedEndPos = t.end;
  }
  const endLine = lineOf(Math.max(usedEndPos - 1, 0));
  return {
    label: normalizeLabel(label),
    dest,
    title,
    linesUsed: endLine + 1,
  };
}

// ---------------------------------------------------------------------------
// HTML block detection (CommonMark types 1-7)
// ---------------------------------------------------------------------------
const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Returns { type, endTag } or null if line does not start an HTML block.
// canInterrupt: false when checking interruption of a paragraph (type 7 then
// does not count).
function htmlBlockStart(line, canInterrupt) {
  const w = leadingWs(line);
  if (w.cols > 3) return null;
  const s = line.slice(w.end);
  if (s[0] !== '<') return null;
  // type 2: comment
  if (s.startsWith('<!--')) return { type: 2, close: '-->' };
  // type 3: processing instruction
  if (s.startsWith('<?')) return { type: 3, close: '?>' };
  // type 4: declaration <!X
  if (/^<![A-Z]/.test(s)) return { type: 4, close: '>' };
  // type 5: CDATA
  if (s.startsWith('<![CDATA[')) return { type: 5, close: ']]>' };
  // type 1: script/pre/style/textarea open tag
  const m1 = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(s);
  if (m1) return { type: 1, close: '</' + m1[1].toLowerCase() };
  // type 6: block tag open or close. A closing tag of a type-1 element
  // (script/pre/style/textarea) does not interrupt a paragraph in marked;
  // other block tags, open or closing, do.
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(s);
  if (m6 && HTML_BLOCK_TAGS.has(m6[1].toLowerCase())) {
    const type1Close = s[1] === '/' &&
      (m6[1] === 'script' || m6[1] === 'pre' || m6[1] === 'style' || m6[1] === 'textarea');
    if (canInterrupt || !type1Close) return { type: 6, close: null };
  }
  // type 7: complete open or closing tag alone on the line (rest blank)
  if (canInterrupt === false) return null;
  const tag = scanHtmlTag(s, 0);
  if (tag && tag.complete) {
    const rest = s.slice(tag.end);
    if (/^[ \t]*$/.test(rest) && !HTML_BLOCK_TAGS.has(tag.name.toLowerCase())) {
      return { type: 7, close: null };
    }
    // a block tag alone on the line is type 6 (handled above); a non-block
    // complete tag is type 7 even if rest is blank; if rest is non-blank
    // it's not a block at all.
    if (/^[ \t]*$/.test(rest)) return { type: 7, close: null };
  }
  return null;
}

// Scan an HTML tag starting at s[p] === '<'. Returns
// { end, name, closing, selfClosing, complete } or null if not a valid tag.
function scanHtmlTag(s, p) {
  let i = p + 1;
  let closing = false;
  if (s[i] === '/') { closing = true; i++; }
  if (i >= s.length || !/[A-Za-z]/.test(s[i])) return null;
  let name = '';
  while (i < s.length && /[A-Za-z0-9-]/.test(s[i])) { name += s[i]; i++; }
  if (closing) {
    // a closing tag allows only whitespace before '>'
    while (i < s.length && /[ \t\n]/.test(s[i])) i++;
    if (s[i] === '>') return { end: i + 1, name, closing, selfClosing: false, complete: true };
    if (i >= s.length) return { end: i, name, closing, selfClosing: false, complete: false };
    return null;
  }
  // attributes
  for (;;) {
    let ws = 0;
    while (i < s.length && /[ \t\n]/.test(s[i])) { i++; ws++; }
    if (i >= s.length) return { end: i, name, closing, selfClosing: false, complete: false };
    if (s[i] === '>') return { end: i + 1, name, closing, selfClosing: false, complete: true };
    if (s[i] === '/' && s[i + 1] === '>') return { end: i + 2, name, closing, selfClosing: true, complete: true };
    if (ws === 0) return null; // attributes must be space-separated
    // attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    if (!/[A-Za-z_:]/.test(s[i])) return null;
    i++;
    while (i < s.length && /[A-Za-z0-9_.:-]/.test(s[i])) i++;
    // optional value
    let j = i;
    while (j < s.length && /[ \t\n]/.test(s[j])) j++;
    if (s[j] === '=') {
      j++;
      while (j < s.length && /[ \t\n]/.test(s[j])) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < s.length && s[j] !== q) j++;
        if (j >= s.length) return { end: j, name, closing, selfClosing: false, complete: false };
        j++;
      } else {
        if (j >= s.length || /[\s"'=<>`]/.test(s[j])) return null;
        while (j < s.length && !/[\s"'=<>`]/.test(s[j])) j++;
      }
      i = j;
    }
  }
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------
// Split a table row line into cell texts. Pipes escaped as \| become literal
// pipes in the cell text. Returns array of trimmed cell strings.
function splitRowCells(line) {
  const w = leadingWs(line);
  const s = w.cols <= 3 ? line.slice(w.end) : line;
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  // drop edge empties caused by leading/trailing pipes
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Check whether line j is a delimiter row for a table whose header is
// lines[j-1] with headerCells cells. Returns aligns array or null.
function tableDelimiter(line, headerLine, headerCells) {
  if (headerCells.length === 0) return null;
  // header must contain an unescaped pipe somewhere
  let hasPipe = false;
  for (let i = 0; i < headerLine.length; i++) {
    if (headerLine[i] === '|' && headerLine[i - 1] !== '\\') { hasPipe = true; break; }
  }
  const cells = splitRowCells(line);
  if (cells.length !== headerCells.length) {
    // a one-column table whose delimiter has a pipe is allowed
    if (!(headerCells.length === 1 && cells.length === 1)) return null;
    if (!hasPipe && !line.includes('|')) return null;
  }
  if (!hasPipe && headerCells.length > 1) return null;
  if (!hasPipe && headerCells.length === 1 && !line.includes('|')) return null;
  const aligns = [];
  for (const c of cells) {
    const m = /^(:?)-+(:?)$/.exec(c.replace(/ /g, ''));
    if (!m) return null;
    if (m[1] && m[2]) aligns.push('center');
    else if (m[2]) aligns.push('right');
    else if (m[1]) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// Line classification helpers
// ---------------------------------------------------------------------------
function isHrLine(line) {
  const w = leadingWs(line);
  if (w.cols > 3) return false;
  const s = line.slice(w.end);
  const c = s[0];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

function setextLevel(line) {
  const w = leadingWs(line);
  if (w.cols > 3) return 0;
  const s = line.slice(w.end).replace(/[ \t]+$/, '');
  if (/^=+$/.test(s)) return 1;
  if (/^-+$/.test(s)) return 2;
  return 0;
}

// Match an ATX heading line. Returns { level, text } or null.
function atxHeading(line) {
  const w = leadingWs(line);
  if (w.cols > 3) return null;
  const s = line.slice(w.end);
  let n = 0;
  while (s[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n < s.length && s[n] !== ' ' && s[n] !== '\t') return null;
  let content = s.slice(n).replace(/[ \t]+$/, '');
  // closing sequence of #'s
  const m = /(^|[ \t])#+$/.exec(content);
  if (m) content = content.slice(0, m.index).replace(/[ \t]+$/, '');
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: n, text: content };
}

// Match a fenced code opening. Returns { ch, len, info, indentCols } or null.
function fenceStart(line) {
  const w = leadingWs(line);
  if (w.cols > 3) return null;
  const s = line.slice(w.end);
  const c = s[0];
  if (c !== '`' && c !== '~') return null;
  const n = fenceRun(s, 0, c);
  if (n < 3) return null;
  const info = s.slice(n);
  if (c === '`' && info.includes('`')) return null;
  return { ch: c, len: n, info: info.trim(), indentCols: w.cols };
}

function isFenceClose(line, ch, len) {
  const w = leadingWs(line);
  if (w.cols > 3) return false;
  const s = line.slice(w.end);
  if (s[0] !== ch) return false;
  const n = fenceRun(s, 0, ch);
  if (n < len) return false;
  return /^[ \t]*$/.test(s.slice(n));
}

// Match a list marker at the start of a line.
// Returns { ordered, start, markerEnd (char idx after marker), contentCol,
//           markerColEnd, bullet } or null.
function listMarker(line) {
  const w = leadingWs(line);
  if (w.cols > 3) return null;
  const s = line.slice(w.end);
  if (s === '') return null;
  const c = s[0];
  if (c === '-' || c === '+' || c === '*') {
    const after = s[1];
    if (after !== undefined && after !== ' ' && after !== '\t') return null;
    return finishMarker(line, w, 1, false, 0, c);
  }
  if (c >= '0' && c <= '9') {
    let n = 0;
    let num = 0;
    while (n < s.length && n < 10 && s[n] >= '0' && s[n] <= '9') {
      num = num * 10 + (s[n].charCodeAt(0) - 48);
      n++;
    }
    if (n > 9) return null;
    const d = s[n];
    if (d !== '.' && d !== ')') return null;
    const after = s[n + 1];
    if (after !== undefined && after !== ' ' && after !== '\t') return null;
    return finishMarker(line, w, n + 1, true, num, d);
  }
  return null;
}

function finishMarker(line, w, markerChars, ordered, start, bullet) {
  // whitespace after the marker, in columns
  let p = w.end + markerChars;
  let cols = 0;
  let chars = 0;
  let col = w.cols + markerChars;
  while (p < line.length) {
    const c = line[p];
    if (c === ' ') { cols++; chars++; col++; p++; }
    else if (c === '\t') {
      const adv = 4 - (col % 4);
      cols += adv; chars++; col += adv; p++;
    } else break;
  }
  const endOfLine = p >= line.length;
  let contentCol;
  if (endOfLine) {
    // empty item: content starts one column after the marker end
    contentCol = w.cols + markerChars + 1;
  } else if (cols >= 1 && cols <= 4) {
    contentCol = col;
  } else {
    // 5+ spaces (or none, impossible here): content treated as starting
    // one space after the marker
    contentCol = w.cols + markerChars + 1;
  }
  return {
    ordered,
    start,
    bullet,
    baseCol: w.cols,
    markerEndCol: w.cols + markerChars,
    contentCol,
    empty: endOfLine,
    // character index where the content begins (for contentCol <= line):
    contentIdx: endOfLine ? line.length : (cols >= 1 && cols <= 4 ? p : w.end + markerChars + 1),
  };
}

// Does this line interrupt a paragraph as a list start?
function listInterrupts(line, inList) {
  const m = listMarker(line);
  if (!m) return false;
  if (m.empty) return false;
  // an ordered list interrupts a paragraph with any start number inside
  // a list item; elsewhere only start 1 does
  if (m.ordered && m.start !== 1 && !inList) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------
// lines: array of source lines (no \n). [start, end) range.
// ctx: { defs: Map, eofNl: bool, indentLazy: Set<idx>, breakAfter: Set<idx> }
// Returns array of block tokens.
function lexBlocks(lines, start, end, ctx) {
  const blocks = [];
  const hasNl = (k) => k < end - 1 || ctx.eofNl;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }

    // fenced code
    const fs = fenceStart(line);
    if (fs) {
      const content = [];
      let j = i + 1;
      let closed = false;
      while (j < end) {
        if (isFenceClose(lines[j], fs.ch, fs.len)) { closed = true; break; }
        // marked strips the fence's indent from body lines of backtick
        // fences only; tilde fence bodies keep their indentation
        content.push(fs.ch === '`' ? stripColsTabWhole(lines[j], fs.indentCols) : lines[j]);
        j++;
      }
      // marked's fence capture is the raw text between the opening line
      // and the newline preceding the closing fence; the rendered content
      // then gains a trailing newline iff it is non-empty and lacks one.
      const joined = content.join('\n');
      let cap = joined;
      if (!closed && content.length && hasNl(j - 1)) cap += '\n';
      blocks.push({
        t: 'code',
        text: cap === '' || cap.endsWith('\n') ? cap : cap + '\n',
        lang: fs.info ? unescapeString(fs.info.split(/\s+/)[0]) : '',
        span: [i, (closed ? j : j - 1)],
      });
      i = closed ? j + 1 : j;
      continue;
    }

    // ATX heading
    const atx = atxHeading(line);
    if (atx) {
      blocks.push({ t: 'heading', level: atx.level, text: atx.text, span: [i, i] });
      i++;
      continue;
    }

    // thematic break
    if (isHrLine(line)) {
      blocks.push({ t: 'hr', span: [i, i] });
      i++;
      continue;
    }

    // blockquote
    if (/^ {0,3}>/.test(line)) {
      const r = lexBlockquote(lines, i, end, ctx);
      r.block.span = [i, r.next - 1];
      blocks.push(r.block);
      i = r.next;
      continue;
    }

    // list
    const lm = listMarker(line);
    if (lm) {
      const r = lexList(lines, i, end, ctx, lm);
      r.block.span = [i, r.lastLine];
      blocks.push(r.block);
      i = r.next;
      continue;
    }

    // HTML block
    const hb = htmlBlockStart(line, true);
    if (hb) {
      const r = lexHtmlBlock(lines, i, end, ctx, hb);
      r.block.span = [i, r.next - 1];
      blocks.push(r.block);
      i = r.next;
      continue;
    }

    // indented code block
    if (leadingWs(line).cols >= 4) {
      const content = [];
      let j = i;
      let lastContent = -1;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) {
          // Blank lines are tentative (dropped if trailing), but an
          // interior blank keeps its stripped remainder (a blank indented
          // past 4 columns leaves spaces behind).
          content.push(stripCols(l, 4));
          j++; continue;
        }
        if (leadingWs(l).cols >= 4) {
          content.push(stripCols(l, 4));
          lastContent = content.length - 1;
          j++; continue;
        }
        break;
      }
      content.length = lastContent + 1;
      blocks.push({
        t: 'code',
        text: content.length ? content.join('\n') + '\n' : '',
        lang: '',
        span: [i, i + lastContent],
      });
      i = j;
      continue;
    }

    // link reference definition
    const def = tryParseDef(lines, i, end);
    if (def) {
      if (!ctx.defs.has(def.label)) {
        ctx.defs.set(def.label, { dest: def.dest, title: def.title });
      }
      if (ctx.defSpans) ctx.defSpans.push([i, i + def.linesUsed - 1]);
      i += def.linesUsed;
      continue;
    }

    // table (header line + delimiter line)
    if (i + 1 < end) {
      const headerCells = splitRowCells(line);
      const aligns = tableDelimiter(lines[i + 1], line, headerCells);
      if (aligns) {
        const rows = [];
        let j = i + 2;
        while (j < end) {
          const l = lines[j];
          // a line of spaces plus exactly one tab is an (empty) row in
          // marked, not a blank line
          if (/^[ ]*\t$/.test(l)) { rows.push(splitRowCells(l)); j++; continue; }
          if (isBlankLine(l)) break;
          // any other block start ends the table (heading, fence, hr,
          // list, quote, HTML block, indented code)
          if (!isParaContinuation(l)) break;
          if (leadingWs(l).cols >= 4) break;
          rows.push(splitRowCells(l));
          j++;
        }
        blocks.push({ t: 'table', header: headerCells, aligns, rows, span: [i, j - 1] });
        i = j;
        continue;
      }
    }

    // paragraph
    const r = lexParagraph(lines, i, end, ctx, hasNl);
    r.block.span = [i, r.next - 1];
    blocks.push(r.block);
    i = r.next;
  }
  return blocks;
}

// Collect a paragraph (or setext heading) starting at line i.
function lexParagraph(lines, i, end, ctx, hasNl) {
  const textLines = [lines[i]];
  const textIdx = [i]; // source line index for each text line
  let j = i + 1;
  let heading = 0;
  while (j < end) {
    const l = lines[j];
    if (isBlankLine(l)) {
      // marked quirk: a trailing whitespace-only line at the very end of the
      // (sub)document without a following newline joins the paragraph.
      if (j === end - 1 && l.length > 0 && !hasNl(j)) {
        textLines.push(l);
        textIdx.push(j);
        j++;
      }
      break;
    }
    if (ctx.forceContinue && ctx.forceContinue.has(j)) {
      // a dedented lazy line from a blockquote: plain paragraph text,
      // never an interruption
      textLines.push(l);
      textIdx.push(j);
      j++;
      continue;
    }
    if (ctx.indentLazy && ctx.indentLazy.has(j)) {
      // a lazy setext-underline line absorbed by a blockquote stays
      // paragraph text; it never makes a heading
      textLines.push(l);
      textIdx.push(j);
      j++;
      continue;
    }
    const sx = setextLevel(l);
    if (sx) { heading = sx; j++; break; }
    // table starts here?
    if (j + 1 < end) {
      const aligns = tableDelimiter(lines[j + 1], l, splitRowCells(l));
      if (aligns) break;
    }
    if (fenceStart(l)) break;
    if (atxHeading(l)) break;
    if (isHrLine(l)) break;
    if (/^ {0,3}>/.test(l)) break;
    if (listInterrupts(l, ctx.inList)) break;
    const hb = htmlBlockStart(l, false);
    if (hb && hb.type !== 7) break;
    textLines.push(l);
    textIdx.push(j);
    j++;
  }
  // apply the blockquote lazy-line marks (indent setext lines at idx >= 2,
  // insert a blank text line after "breakAfter" lines)
  let text = '';
  for (let k = 0; k < textLines.length; k++) {
    if (k > 0) text += '\n';
    let tl = textLines[k];
    if (ctx.indentLazy && ctx.indentLazy.has(textIdx[k]) && k >= 2) {
      tl = '    ' + tl;
    }
    text += tl;
    if (ctx.breakAfter && ctx.breakAfter.has(textIdx[k]) && k < textLines.length - 1) {
      text += '\n';
    }
  }
  if (heading) {
    return {
      block: { t: 'heading', level: heading, text: text.trim() },
      next: j,
    };
  }
  return { block: { t: 'paragraph', text }, next: j };
}

// HTML block collection.
function lexHtmlBlock(lines, i, end, ctx, hb) {
  const rawLines = [lines[i]];
  let j = i + 1;
  if (hb.type === 1 || hb.type === 2 || hb.type === 3 || hb.type === 4 || hb.type === 5) {
    // until a line containing the close sequence (inclusive)
    let done = lines[i].includes(hb.close);
    if (hb.type === 1) {
      // close is like '</script' — need the full close tag start in the line
      done = lines[i].toLowerCase().includes(hb.close);
    }
    while (!done && j < end) {
      rawLines.push(lines[j]);
      const l = hb.type === 1 ? lines[j].toLowerCase() : lines[j];
      if (l.includes(hb.close)) done = true;
      j++;
    }
  } else {
    // types 6 and 7: until a blank line (exclusive)
    while (j < end && !isBlankLine(lines[j])) {
      rawLines.push(lines[j]);
      j++;
    }
  }
  // marked keeps a trailing newline after the block when another block
  // follows immediately (no blank line between), or when the block reaches
  // the end of the (sub)document and that source ends with a newline.
  // For terminator-ended blocks (types 1-5) a following line that is
  // whitespace-only but not literally empty still counts as "follows".
  let raw = rawLines.join('\n');
  const termEnded = hb.type >= 1 && hb.type <= 5;
  const follows = j < end && (termEnded ? lines[j] !== '' : !isBlankLine(lines[j]));
  if (follows || (j === end && ctx.eofNl)) raw += '\n';
  return { block: { t: 'html', raw }, next: j };
}

// ---------------------------------------------------------------------------
// Container helpers
// ---------------------------------------------------------------------------
// Does the block tree end with an open (continuable) paragraph?
function tailOpenParagraph(blocks) {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  if (last.t === 'paragraph') return true;
  if (last.t === 'quote') return tailOpenParagraph(last.blocks);
  if (last.t === 'list') {
    if (last.items.length === 0) return false;
    return tailOpenParagraph(last.items[last.items.length - 1].blocks);
  }
  return false;
}

// Like chunkEndsWithOpenParagraph, but only a paragraph at the chunk's
// own top level counts (not one nested inside a sub-list or quote).
function chunkEndsWithTopParagraph(chunkLines, inList) {
  if (chunkLines.length === 0) return false;
  const scratch = {
    defs: new Map(), eofNl: false, inList: !!inList,
    indentLazy: null, breakAfter: null, forceContinue: null,
  };
  const blocks = lexBlocks(chunkLines, 0, chunkLines.length, scratch);
  return blocks.length > 0 && blocks[blocks.length - 1].t === 'paragraph';
}

// Whether the chunk's trailing top-level block is a paragraph that
// follows a nested list block (the extra indent strip for paragraph
// continuation lines does not apply to such paragraphs).
function chunkParaFollowsList(chunkLines, inList) {
  if (chunkLines.length === 0) return false;
  const scratch = {
    defs: new Map(), eofNl: false, inList: !!inList,
    indentLazy: null, breakAfter: null, forceContinue: null,
  };
  const blocks = lexBlocks(chunkLines, 0, chunkLines.length, scratch);
  if (blocks.length === 0 || blocks[blocks.length - 1].t !== 'paragraph') return false;
  for (let b = 0; b + 1 < blocks.length; b++) {
    if (blocks[b].t === 'list') return true;
  }
  return false;
}

// Speculatively lex a chunk of lines and report whether it ends with an
// open paragraph (for laziness checks). Uses a throwaway defs map.
function chunkEndsWithOpenParagraph(chunkLines, inList) {
  if (chunkLines.length === 0) return false;
  const scratch = {
    defs: new Map(), eofNl: false, inList: !!inList,
    indentLazy: null, breakAfter: null, forceContinue: null,
  };
  const blocks = lexBlocks(chunkLines, 0, chunkLines.length, scratch);
  return tailOpenParagraph(blocks);
}

// Is this line paragraph-continuation text (for laziness / interruption)?
function isParaContinuation(line) {
  if (isBlankLine(line)) return false;
  if (setextLevel(line) === 1) return true; // === underline: continuation
  if (isHrLine(line)) return false;
  if (fenceStart(line)) return false;
  if (atxHeading(line)) return false;
  if (/^ {0,3}>/.test(line)) return false;
  if (listInterrupts(line, false)) return false;
  const hb = htmlBlockStart(line, false);
  if (hb) return false;
  return true;
}

// Strip the blockquote marker from a line known to match /^ {0,3}>/.
function stripQuoteMarker(line) {
  // line matches /^ {0,3}>/ (leading chars are spaces). The inner line is
  // what follows the '>' minus ONE column of whitespace (if any); the rest
  // of the whitespace run is expanded to spaces at its original widths.
  const w = leadingWs(line);
  const rest = line.slice(w.end + 1); // drop '>'
  if (rest === '') return '';
  const c0 = rest[0];
  if (c0 === ' ') return expandWsRun(rest, 1, w.cols + 2);
  if (c0 === '\t') {
    const startCol = w.cols + 1;
    const width = 4 - (startCol % 4);
    return ' '.repeat(width - 1) + expandWsRun(rest, 1, startCol + width);
  }
  return rest;
}

function lexBlockquote(lines, i, end, ctx) {
  const inner = [];
  const indentLazy = new Set();
  const breakAfter = new Set();
  const forceContinue = new Set();
  let k = i;
  while (k < end) {
    const line = lines[k];
    if (/^ {0,3}>/.test(line)) {
      inner.push(stripQuoteMarker(line));
      k++;
      continue;
    }
    if (isBlankLine(line)) break;
    // possible lazy line (never across a blank inner line: the paragraph
    // must still be open at the chunk's tail)
    if (inner.length === 0) break;
    if (isBlankLine(inner[inner.length - 1])) break;
    if (!isParaContinuation(line)) break;
    if (!chunkEndsWithOpenParagraph(inner, false)) break;
    // accept the lazy line
    const idx = inner.length;
    const w = leadingWs(line);
    if (setextLevel(line) === 1 || (setextLevel(line) === 2 && !isHrLine(line))) {
      indentLazy.add(idx);
      inner.push(line);
    } else if (w.cols >= 4) {
      inner.push(stripCols(line, 4));
      breakAfter.add(idx);
      forceContinue.add(idx);
    } else {
      inner.push(line);
    }
    k++;
  }
  const childCtx = {
    defs: ctx.defs, eofNl: false, inList: false,
    indentLazy, breakAfter, forceContinue,
    defSpans: [],
  };
  const blocks = lexBlocks(inner, 0, inner.length, childCtx);
  return { block: { t: 'quote', blocks }, next: k };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
function sameFamily(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.bullet === b.bullet;
}

function lexList(lines, i, end, ctx, firstMarker) {
  const items = [];
  let loose = false;
  let k = i;
  let marker = firstMarker;
  let lastLine = i; // last line actually consumed into an item chunk
  for (;;) {
    // collect one item starting at line k (marker line)
    const contentCol = marker.contentCol;
    const chunk = [];
    chunk.push(sliceExpanded(lines[k], contentCol));
    const lazyMarks = new Set();
    const breakAfter = new Set();
    let hasContent = !isBlankLine(chunk[0]);
    let pendingBlanks = 0;
    let blankBetween = false;
    let j = k + 1;
    let itemDone = false;
    let listDone = false;
    // marked keeps consuming lines into the item while a fenced code
    // block is open, even lines that are not indented to the content
    // column (the fence's body is part of the item's raw text)
    let openFence = fenceStart(chunk[0]);
    // a fence body line that is not indented to the content column is
    // only kept once an indented body line has started the body; if the
    // first body line is unindented the fence ends the item (empty)
    let fenceStarted = false;
    // stripped indent of the previous non-blank fence body line; a
    // body line at code depth (>= 4 after the frame strip) makes a
    // following unindented line end the fence and the item
    let fencePrevIndent = 0;
    // whether the previous non-blank fence body line starts an HTML
    // block (types 1-6): a following unindented line then also ends
    // the fence and the item
    let fencePrevHtml = false;
    // whether the previous non-blank body line starts with a fence
    // run: a following unindented line also ends the fence and item
    let fencePrevRun = false;
    const trackFence = (frameLine) => {
      if (openFence) {
        if (isFenceClose(frameLine, openFence.ch, openFence.len)) openFence = null;
      } else {
        openFence = fenceStart(frameLine);
        fenceStarted = false;
        fencePrevIndent = 0;
        fencePrevHtml = false;
        fencePrevRun = false;
      }
    };
    while (j < end && !itemDone && !listDone) {
      const l = lines[j];
      if (openFence) {
        const w0 = leadingWs(l);
        if (!isBlankLine(l) && w0.cols < contentCol &&
            (!fenceStarted || fencePrevIndent >= 4 || fencePrevHtml || fencePrevRun)) {
          listDone = true;
          break;
        }
        const frameLine = w0.cols >= contentCol
          ? sliceExpanded(l, contentCol)
          : stripCols(l, contentCol);
        chunk.push(isBlankLine(l) ? '' : frameLine);
        if (!isBlankLine(l)) {
          if (w0.cols >= contentCol) fenceStarted = true;
          fencePrevIndent = leadingWs(frameLine).cols;
          const hb = htmlBlockStart(frameLine, true);
          fencePrevHtml = hb !== null && hb.type <= 6;
          const fw = leadingWs(frameLine);
          fencePrevRun = fw.cols <= 3 &&
            (frameLine.startsWith('```', fw.end) || frameLine.startsWith('~~~', fw.end));
          trackFence(frameLine);
        }
        hasContent = true;
        lastLine = j;
        j++;
        continue;
      }
      if (isBlankLine(l)) { pendingBlanks++; j++; continue; }
      const w = leadingWs(l);
      // A thematic break ends the list outright (checked before the
      // next-item test: `* * *` is a break, not an item).
      if (w.cols < contentCol && isHrLine(l)) { listDone = true; break; }
      const lm = w.cols < contentCol ? listMarker(l) : null;
      // A sibling marker may sit at any base column below this item's
      // content column (indented more deeply it would be item content).
      const isSibling = lm !== null && sameFamily(lm, marker) && lm.baseCol < contentCol;
      if (isSibling) {
        // next item begins
        if (pendingBlanks > 0) blankBetween = true;
        itemDone = true;
        break;
      }
      if (lm) {
        // a list marker of a different family/delimiter ends this list
        listDone = true;
        break;
      }
      if (pendingBlanks > 0 && !hasContent) {
        // an item that is still empty after a blank line ends here;
        // following lines belong outside the list
        listDone = true;
        break;
      }
      if (w.cols >= contentCol) {
        const hadBlanks = pendingBlanks > 0;
        for (let b = 0; b < pendingBlanks; b++) chunk.push('');
        pendingBlanks = 0;
        let frameLine = sliceExpanded(l, contentCol);
        // a line absorbed into the item's open paragraph is stripped
        // deeper in marked: the strip is the largest amount <= the
        // line's indent that is congruent to contentCol mod 4
        if (!hadBlanks && w.cols - contentCol >= 4 &&
            isParaContinuation(frameLine) &&
            chunkEndsWithTopParagraph(chunk, true) &&
            !chunkParaFollowsList(chunk, true)) {
          const extra = Math.floor((w.cols - contentCol) / 4) * 4;
          frameLine = sliceExpanded(l, contentCol + extra);
          lazyMarks.add(chunk.length);
          breakAfter.add(chunk.length);
        }
        chunk.push(frameLine);
        trackFence(frameLine);
        hasContent = true;
        lastLine = j;
        j++;
        continue;
      }
      // lazy continuation (never across a blank line); marked strips
      // only whole tab stops (4-column units) from such a line, and the
      // line is marked so the item's paragraph lexer treats it as text
      if (pendingBlanks === 0 && isParaContinuation(l) && chunkEndsWithOpenParagraph(chunk, true)) {
        lazyMarks.add(chunk.length);
        chunk.push(sliceExpanded(l, Math.floor(w.cols / 4) * 4));
        lastLine = j;
        j++;
        continue;
      }
      listDone = true;
    }
    if (blankBetween) loose = true;
    // lex the item chunk
    const childCtx = {
      defs: ctx.defs, eofNl: false, inList: true,
      indentLazy: null, breakAfter: breakAfter.size ? breakAfter : null,
      forceContinue: lazyMarks.size ? lazyMarks : null,
      defSpans: [],
    };
    const blocks = lexBlocks(chunk, 0, chunk.length, childCtx);
    // blank line between two consumed segments (blocks or link reference
    // definitions) inside the item => loose
    const segs = blocks.map(b => b.span).concat(childCtx.defSpans);
    segs.sort((a, b) => a[0] - b[0]);
    for (let b = 0; b + 1 < segs.length; b++) {
      const gapFrom = segs[b][1] + 1;
      const gapTo = segs[b + 1][0] - 1;
      for (let g = gapFrom; g <= gapTo; g++) {
        if (isBlankLine(chunk[g])) { loose = true; break; }
      }
      if (loose) break;
    }
    // task list item?
    let task = false;
    let checked = false;
    if (blocks.length > 0 && blocks[0].t === 'paragraph') {
      const txt = blocks[0].text;
      const m = /^\[(x|X| |)\] /.exec(txt);
      if (m) {
        task = true;
        checked = m[1] === 'x' || m[1] === 'X';
        blocks[0].text = txt.slice(m[0].length);
        if (blocks[0].text === '') blocks.shift();
      }
    }
    items.push({ blocks, task, checked });
    if (k > lastLine) lastLine = k;
    if (listDone || !itemDone) {
      k = j;
      break;
    }
    // start the next item at line j
    marker = listMarker(lines[j]);
    k = j;
  }
  return {
    block: {
      t: 'list',
      ordered: firstMarker.ordered,
      start: firstMarker.start,
      loose,
      items,
    },
    next: k,
    lastLine,
  };
}

// ---------------------------------------------------------------------------
// Rendering of block tokens
// ---------------------------------------------------------------------------
function codeOpenTag(lang) {
  if (!lang) return '<pre><code>';
  return '<pre><code class="language-' + escapeText(lang) + '">';
}

function renderBlocks(blocks, defs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, defs);
  return out;
}

function renderBlock(b, defs) {
  switch (b.t) {
    case 'paragraph':
      return '<p>' + parseInline(b.text, defs) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + parseInline(b.text, defs) + '</h' + b.level + '>\n';
    case 'code':
      return codeOpenTag(b.lang) + escapeCode(b.text) + '</code></pre>\n';
    case 'hr':
      return '<hr>\n';
    case 'html':
      return b.raw;
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.blocks, defs) + '</blockquote>\n';
    case 'list':
      return renderList(b, defs);
    case 'table':
      return renderTable(b, defs);
    default:
      return '';
  }
}

function renderList(list, defs) {
  let out;
  if (list.ordered) {
    out = list.start !== 1 ? '<ol start="' + list.start + '">\n' : '<ol>\n';
  } else {
    out = '<ul>\n';
  }
  for (const item of list.items) {
    let content = '';
    if (list.loose) {
      content = renderBlocks(item.blocks, defs);
      if (item.task) {
        const cb = item.checked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
        if (content.startsWith('<p>')) content = '<p>' + cb + content.slice(3);
        else content = cb + content;
      }
    } else {
      let first = true;
      for (const b of item.blocks) {
        if (b.t === 'paragraph') {
          let inner = parseInline(b.text, defs);
          if (item.task && first) {
            const cb = item.checked
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
            inner = cb + inner;
          }
          content += inner;
        } else {
          content += renderBlock(b, defs);
        }
        first = false;
      }
      if (item.task && item.blocks.length === 0) {
        content = (item.checked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ') + content;
      }
    }
    out += '<li>' + content + '</li>\n';
  }
  out += list.ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

function renderTable(b, defs) {
  let out = '<table>\n<thead>\n<tr>\n';
  const cellTag = (tag, align, text) =>
    '<' + tag + (align ? ' align="' + align + '"' : '') + '>' +
    parseInline(text, defs) + '</' + tag + '>\n';
  for (let c = 0; c < b.header.length; c++) {
    out += cellTag('th', b.aligns[c], b.header[c]);
  }
  out += '</tr>\n</thead>\n';
  if (b.rows.length > 0) {
    out += '<tbody>';
    for (const row of b.rows) {
      out += '<tr>\n';
      for (let c = 0; c < b.header.length; c++) {
        out += cellTag('td', b.aligns[c], c < row.length ? row[c] : '');
      }
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
let NODE_SEQ = 0;

function textNode(rawText) {
  return { k: 'text', html: escapeText(rawText), plain: rawText, seq: NODE_SEQ++ };
}
function rawNode(html, plain) {
  return { k: 'raw', html, plain: plain || '', seq: NODE_SEQ++ };
}

// Plain-text extraction from a node list (for image alt text).
function plainOfNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.k === 'delim') out += n.ch.repeat(n.len);
    else out += n.plain || '';
  }
  return out;
}

const INTERESTING = new Set(['\\', '`', '<', '!', '[', ']', '*', '_', '~', '&', '\n', '@', 'w', 'h', 'f', 'm', 'x', 'W', 'H', 'F', 'M', 'X']);
const EMAIL_LOCAL_CHARS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.+_-");

function parseInline(text, defs) {
  const docState = defs.docState || (defs.docState = { inLinkTag: false });
  const s = text;
  const nodes = [];
  const delimStack = []; // {node, ch, canOpen, canClose}
  // when a link's text ends inside an unterminated backtick span of
  // length L, marked leaves every delimiter run inert until the next
  // run of L backticks (which is itself literal): deadDelim tracks L
  let deadDelim = 0;
  let deadEnd = 0;
  let deadGate = -1;
  // marked quirk: when a delimiter run that can both open and close forms
  // an em (use 1) pair that fully consumes a length-1 opener, the openers
  // below it become "guarded": a later closer of the same char cannot pair
  // with a guarded length-2 opener while the budget lasts (budget starts
  // at 2 and is spent by the lengths of closers it blocks; a blocked
  // closer that can itself open does not spend budget)
  let poison = new Map(); // per char: {guarded: Set<entry>, budget, caseB, fromNode}
  const bracketStack = []; // {node, isImage, active, srcIdx}
  let buf = '';
  let i = 0;
  const n = s.length;

  const flushBuf = () => {
    if (buf) {
      nodes.push(textNode(buf));
      buf = '';
    }
  };

  // -- emphasis processing over the delimiter stack, for entries whose node
  // seq is greater than floorSeq.
  // a `_` pairing is rejected when a `**` run (exactly two stars, in
  // live text or as a delimiter) sits between the opener and the
  // closer and another `**` run appears later in the block: the
  // closer stays unmatched and the opener survives for a later closer
  function starRun2(text) {
    for (let k = 0; k + 1 < text.length; k++) {
      if (text[k] === '*' && text[k + 1] === '*' &&
          text[k - 1] !== '*' && text[k + 2] !== '*') return true;
    }
    return false;
  }
  function underscoreBlocked(opener, closer, oiS, ciS) {
    // an unmatched `**` run between the pair: either a live stack
    // entry that has not been consumed, or an inert run in plain text
    let between = false;
    for (let k = oiS + 1; k < ciS; k++) {
      const e = delimStack[k];
      if (e.ch === '*' && e.node.runLen === 2 && e.node.len > 0) { between = true; break; }
    }
    const oi = nodes.indexOf(opener.node);
    const ci = nodes.indexOf(closer.node);
    if (oi < 0 || ci < 0) return false;
    if (!between) {
      for (let k = oi + 1; k < ci; k++) {
        const nd = nodes[k];
        if (nd.k === 'text' && starRun2(nd.plain)) { between = true; break; }
      }
    }
    if (!between) return false;
    for (let k = ci + 1; k < nodes.length; k++) {
      const nd = nodes[k];
      if (nd.k === 'text' && starRun2(nd.plain)) return true;
      if (nd.k === 'delim' && nd.ch === '*' && nd.runLen === 2) return true;
    }
    return false;
  }

  function processEmphasis(floorSeq) {
    // the poison state is local to one emphasis pass: a match made
    // while resolving a link's text must not affect the enclosing text
    const savedPoison = poison;
    poison = new Map();
    // find first closer above the floor
    let ci = 0;
    while (ci < delimStack.length) {
      const closer = delimStack[ci];
      if (closer.node.seq <= floorSeq || !closer.canClose || closer.node.len === 0) {
        ci++;
        continue;
      }
      // find nearest matching opener below ci
      let oi = ci - 1;
      let matched = false;
      let poisonBlocked = false;
      while (oi >= 0 && delimStack[oi].node.seq > floorSeq) {
        const opener = delimStack[oi];
        if (opener.ch === closer.ch && opener.canOpen && opener.node.len > 0) {
          if (closer.ch === '_' && underscoreBlocked(opener, closer, oi, ci)) {
            oi--;
            continue;
          }
          const pz = poison.get(closer.ch);
          if (pz && pz.guarded.has(opener) && closer.node !== pz.fromNode) {
            if (pz.caseB) {
              // case B: the guarded opener is skipped for this closer
              // while budget lasts and the lengths sum to at most 3
              if (pz.budget > 0 && closer.node.len + opener.node.len <= 3) {
                poisonBlocked = true;
                oi--;
                continue;
              }
            } else if (opener.node.len === 2 && closer.node.len <= pz.budget) {
              poisonBlocked = true;
              break;
            }
          }
          // rule of 3: only when one of the runs can both open and close
          if ((closer.canOpen || opener.canClose) &&
              (opener.node.len + closer.node.len) % 3 === 0 &&
              !(opener.node.len % 3 === 0 && closer.node.len % 3 === 0)) {
            oi--;
            continue;
          }
          // apply
          let use;
          if (closer.ch === '~') {
            use = opener.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
          } else {
            use = opener.node.len >= 2 && closer.node.len >= 2 ? 2 : 1;
          }
          const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
          opener.node.len -= use;
          closer.node.len -= use;
          if (opener.node.len === 0 &&
              ((closer.canOpen && (use === 1 || (use === 2 && !opener.canClose))) ||
               (use === 2 && !opener.canClose &&
                s[closer.node.pos + closer.node.runLen] === '~'))) {
            poison.set(closer.ch, {
              guarded: new Set(delimStack.slice(0, oi)),
              budget: use === 2 ? 2 : (opener.canClose ? 1 : 2),
              caseB: use === 2,
              fromNode: closer.node,
            });
          }
          const pz2 = poison.get(closer.ch);
          if (use === 2 && pz2 && pz2.guarded.has(opener)) {
            // a strong pairing that escapes the poison block consumes
            // the closer run from its right: leftover stars render inside
            closer.node.flip = true;
          }
          opener.node.open = '<' + tag + '>' + (opener.node.open || '');
          closer.node.close = (closer.node.close || '') + '</' + tag + '>';
          // delimiters between opener and closer are deactivated
          for (let k = oi + 1; k < ci; k++) delimStack[k].dead = true;
          delimStack.splice(oi + 1, ci - oi - 1);
          ci = oi + 1;
          matched = true;
          if (closer.node.len === 0) break;
          // else keep closing with the same closer against earlier openers
        } else {
          oi--;
        }
      }
      if (poisonBlocked && !matched) {
        const pz3 = poison.get(closer.ch);
        if (pz3 && !closer.canOpen) {
          pz3.budget -= closer.node.len;
          if (pz3.budget <= 0) poison.delete(closer.ch);
        }
        ci++;
        continue;
      }
      if (!matched) ci++;
      // if closer fully used, remove it
      if (closer.node.len === 0) {
        const idx = delimStack.indexOf(closer);
        if (idx >= 0) delimStack.splice(idx, 1);
        // ci stays (next closer shifted into place)
      }
    }
    // finalize: drop all entries above the floor
    for (let k = delimStack.length - 1; k >= 0; k--) {
      if (delimStack[k].node.seq > floorSeq) delimStack.splice(k, 1);
    }
    poison = savedPoison;
  }

  function flanking(pos, runLen) {
    const before = pos > 0 ? s[pos - 1] : '';
    const after = pos + runLen < n ? s[pos + runLen] : '';
    const beforeWs = before === '' || isWs(before);
    const afterWs = after === '' || isWs(after);
    const beforeP = before !== '' && isPunct(before);
    const afterP = after !== '' && isPunct(after);
    const left = !afterWs && (!afterP || beforeWs || beforeP);
    const right = !beforeWs && (!beforeP || afterWs || afterP);
    return { left, right, before, after };
  }

  // True when a delimiter run starting at pos would close an emphasis
  // that is currently open on the delimiter stack. Marked lexes the
  // inside of an emphasis span as its own inline source, so an email
  // or autolink candidate ends right before such a run.
  function isCloserRunStart(pos) {
    const c = s[pos];
    if (c !== '*' && c !== '_' && c !== '~') return false;
    let len = 1;
    while (s[pos + len] === c) len++;
    if (c === '~' && len > 2) return false;
    const f = flanking(pos, len);
    let canClose;
    if (c === '_') canClose = f.right && (!f.left || isPunct(f.after));
    else canClose = f.right;
    if (!canClose) return false;
    for (let k = delimStack.length - 1; k >= 0; k--) {
      const d = delimStack[k];
      if (d.ch === c && d.canOpen && d.node.len > 0) return true;
    }
    return false;
  }

  // Compute the final URL text of an extended autolink starting at
  // `start` (s[start..] begins with the scheme/www prefix). When
  // capAtBracket is set, the raw run stops before the first unescaped
  // ']' (the bracket that may become a link must be able to close).
  function scanAutolinkUrl(start, capAtBracket) {
    let j = start;
    while (j < n && !isWs(s[j]) && s[j] !== '<' && !isCloserRunStart(j)) {
      if (capAtBracket && s[j] === ']' && s[j - 1] !== '\\') break;
      j++;
    }
    let run = s.slice(start, j);
    // a '(' with no ')' anywhere after it ends the URL just before it
    const lastClose = run.lastIndexOf(')');
    for (let k = 0; k < run.length; k++) {
      if (run[k] === '(' && k > lastClose) { run = run.slice(0, k); break; }
    }
    return trimAutolinkUrl(run);
  }

  // Simulate marked's bracket search over the backtick runs in
  // s[from..to): a span opens at a run; a run of the same length closes
  // it; a shorter run is span content; a longer run closes it (excess
  // discarded). A closed span whose content holds an odd number of
  // runs is "fragile". The bracket search fails (-1) when:
  //  - a span of length 1 is still open at the end, unless an odd
  //    number of fragile spans precede it;
  //  - a span of length >= 2 is still open whose content holds a
  //    positive even number of runs;
  //  - content follows the last run (even just a space) and the
  //    parity is wrong: with no open span, an odd number of fragile
  //    spans; with an open span whose content is empty, an even
  //    number of fragile spans before it.
  // Otherwise returns the length of the span still open at the end
  // (0 when every span closed).
  function linkTextBackticks(from, to) {
    let pending = 0;
    let inner = 0;
    let fragile = 0;
    let lastEnd = -1;
    let p = from;
    while (p < to) {
      const c = s[p];
      if (c === '\\') { p += 2; continue; }
      if (c !== '`') { p++; continue; }
      let m = 0;
      while (p + m < to && s[p + m] === '`') m++;
      if (pending === 0) {
        pending = m;
        inner = 0;
      } else if (m >= pending) {
        if (inner % 2 === 1) fragile++;
        pending = 0;
        inner = 0;
      } else {
        inner++;
      }
      p += m;
      lastEnd = p;
    }
    if (lastEnd < 0) return { v: 0, tailInner: 0 };
    const trailing = to > lastEnd;
    if (pending === 1) return { v: fragile % 2 === 1 ? 1 : -1, tailInner: inner };
    if (pending > 0) {
      if (inner > 0 && inner % 2 === 0) return { v: -1, tailInner: inner };
      if (inner === 0 && trailing && fragile % 2 === 0) return { v: -1, tailInner: inner };
      return { v: pending, tailInner: inner };
    }
    if (trailing && fragile % 2 === 1) return { v: -1, tailInner: 0 };
    return { v: 0, tailInner: 0 };
  }

  // Find the ']' that closes the bracket whose text starts at `from`,
  // counting nested brackets (backticks are handled by the simulation).
  function bracketCloseCandidate(from) {
    let depth = 1;
    let p = from;
    while (p < n) {
      const c = s[p];
      if (c === '\\') { p += 2; continue; }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) return p;
      }
      p++;
    }
    return -1;
  }

  // Try to form a link/image at a ']' (index i in s). Returns the new index
  // after the consumed construct, or -1 if not a link.
  // When a bracket fails to form a link, an autolink node that was
  // capped at this ']' extends over it (marked only suppresses the
  // autolink while lexing the text of a link that actually forms).
  // Returns the source position just past the extended URL, or -1.
  function extendCappedAutolink(closeIdx) {
    // find the nearest capped autolink node, skipping over plain text
    // nodes that the uncapped URL would have swallowed (e.g. a ')'
    // that the capped scan trimmed)
    let k = nodes.length - 1;
    let span = 0;
    while (k >= 0) {
      const nd = nodes[k];
      if (nd.auto && nd.autoCapEnd >= 0) break;
      if (nd.k !== 'text') return -1;
      span += nd.plain.length;
      k--;
    }
    if (k < 0) return -1;
    const nd = nodes[k];
    if (nd.autoCapEnd + span !== closeIdx) return -1;
    const url = scanAutolinkUrl(nd.autoStart, false);
    if (url.length <= nd.plain.length) return -1;
    const href = nd.autoKind === 'www' ? 'http://' + url : url;
    nd.html = '<a href="' + escapeText(cleanUrl(href) ?? href) + '">' + escapeText(url) + '</a>';
    nd.plain = url;
    nd.autoCapEnd = -1;
    nodes.length = k + 1;
    return nd.autoStart + url.length;
  }

  // When marked's bracket search fails on the backtick runs in a
  // link's text, every delimiter run inside that text stays inert.
  function deadenBracketDelims(br) {
    const oi = nodes.indexOf(br.node);
    if (oi < 0) return;
    for (let k = oi + 1; k < nodes.length; k++) {
      const nd = nodes[k];
      if (nd.k === 'delim') {
        const raw = nd.ch.repeat(nd.runLen ?? nd.len);
        nodes[k] = { k: 'text', html: escapeText(raw), plain: raw, seq: nd.seq };
      } else if (nd.k === 'entity') {
        nd.frozen = true;
        for (const p of nd.parts) {
          if (p.delim) {
            const ix = delimStack.findIndex(e => e.node === p.delim);
            if (ix >= 0) delimStack.splice(ix, 1);
          }
        }
      }
    }
  }

  function tryLink(closeIdx) {
    if (bracketStack.length === 0) return -1;
    const br = bracketStack[bracketStack.length - 1];
    if (!br.active) {
      // a bracket deactivated by a collapsed reference inside it has
      // its delimiters deadened when it is then closed as a full
      // reference with a defined label
      if (br.innerCollapsed && s[closeIdx + 1] === '[') {
        let j = closeIdx + 2;
        let depth = 1;
        let lab = '';
        while (j < n && depth > 0) {
          const c = s[j];
          if (c === '\\' && j + 1 < n) { lab += c + s[j + 1]; j += 2; continue; }
          if (c === '[') depth++;
          if (c === ']') depth--;
          if (depth > 0) lab += c;
          j++;
        }
        if (depth === 0 && lab !== '' && normalizeLabel(lab) !== '' &&
            defs.has(normalizeLabel(lab))) {
          deadenBracketDelims(br);
        }
      }
      bracketStack.pop();
      return extendCappedAutolink(closeIdx);
    }
    // marked's bracket search can fail on backtick runs in the text:
    // the ']' is then literal text, not a link close. The failure only
    // applies to inline links and full references; collapsed and
    // shortcut references still form.
    const btRes = linkTextBackticks(br.srcIdx + (br.isImage ? 2 : 1), closeIdx);
    const btPending = btRes.v;
    br.btPending = btPending;
    br.btTailInner = btRes.tailInner;
    let dest = null;
    let title = null;
    let endPos = -1;
    let armRegion = false; // inline links and collapsed refs only
    let wasCollapsed = false;
    let labelText = null; // for ref lookups
    const after = closeIdx + 1;
    let formed = false;
    if (s[after] === '(') {
      if (btPending < 0) {
        deadenBracketDelims(br);
        bracketStack.pop();
        return extendCappedAutolink(closeIdx);
      }
      // inline link
      let p = after + 1;
      // skip whitespace
      let q = p;
      while (q < n && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
      if (s[q] === ')') {
        dest = '';
        endPos = q + 1;
      } else {
        const d = scanLinkDest(s, p, true);
        if (d) {
          const t = scanLinkTitle(s, d.end, true);
          let pp;
          if (t) {
            title = t.title;
            pp = t.end;
          } else {
            pp = d.end;
          }
          // skip ws then require ')'
          let r = pp;
          let nl = 0;
          while (r < n && (s[r] === ' ' || s[r] === '\t' || s[r] === '\n')) {
            if (s[r] === '\n') nl++;
            r++;
          }
          if (nl <= 1 && s[r] === ')') {
            dest = d.dest;
            endPos = r + 1;
          }
        }
      }
      if (endPos >= 0) { formed = true; armRegion = true; }
      // a failed inline parse falls through to the shortcut reference
    }
    if (!formed && s[after] === '[') {
      // full or collapsed reference
      let j = after + 1;
      let depth = 1;
      let lab = '';
      while (j < n) {
        const c = s[j];
        if (c === '\\' && j + 1 < n) { lab += c + s[j + 1]; j += 2; continue; }
        if (c === '[') { depth++; lab += c; j++; continue; }
        if (c === ']') {
          depth--;
          if (depth === 0) break;
          lab += c; j++; continue;
        }
        lab += c; j++;
      }
      if (depth === 0) {
        if (lab === '') {
          // collapsed: label is the link text source
          labelText = s.slice(br.srcIdx + (br.isImage ? 2 : 1), closeIdx);
          armRegion = true;
          wasCollapsed = true;
        } else if (normalizeLabel(lab) !== '') {
          if (btPending < 0) {
            deadenBracketDelims(br);
            bracketStack.pop();
            return extendCappedAutolink(closeIdx);
          }
          labelText = lab;
        }
        if (labelText !== null) {
          const def = defs.get(normalizeLabel(labelText));
          if (!def) { bracketStack.pop(); return extendCappedAutolink(closeIdx); }
          dest = def.dest;
          title = def.title;
          endPos = j + 1;
          formed = true;
        }
        // a whitespace-only label counts as no reference: fall through
      }
      // an unclosed label falls through to the shortcut reference
    }
    if (!formed) {
      // shortcut reference (labels match on their raw source text)
      labelText = s.slice(br.srcIdx + (br.isImage ? 2 : 1), closeIdx);
      const def = defs.get(normalizeLabel(labelText));
      if (!def) { bracketStack.pop(); return extendCappedAutolink(closeIdx); }
      dest = def.dest;
      title = def.title;
      endPos = after;
    }
    // Form the link/image.
    bracketStack.pop();
    const openerIdx = nodes.indexOf(br.node);
    // process emphasis inside the bracket first
    processEmphasis(br.node.seq);
    const href = cleanUrl(unescapeString(dest));
    const titleText = title !== null && title !== undefined
      ? unescapeString(title)
      : null;
    if (br.isImage) {
      const content = nodes.slice(openerIdx + 1);
      const alt = plainOfNodes(content);
      nodes.length = openerIdx;
      if (href === null) {
        nodes.push(textNode(alt));
      } else {
        let html = '<img src="' + escapeText(href) + '" alt="' + escapeText(alt) + '"';
        if (titleText) html += ' title="' + escapeText(titleText) + '"';
        html += '>';
        nodes.push(rawNode(html, alt));
      }
    } else {
      // extended autolinks do not form inside link text: revert any
      // created while scanning this bracket's content to plain text
      for (let k = openerIdx + 1; k < nodes.length; k++) {
        const nd = nodes[k];
        if (nd.auto) {
          nodes[k] = { k: 'text', html: escapeText(nd.plain), plain: nd.plain, seq: nd.seq };
        }
      }
      // deactivate earlier link openers
      for (const b2 of bracketStack) {
        if (!b2.isImage) {
          b2.active = false;
          if (wasCollapsed) b2.innerCollapsed = true;
        }
      }
      if (href === null) {
        // children only: drop the opener marker
        nodes.splice(openerIdx, 1);
      } else {
        let openTag = '<a href="' + escapeText(href) + '"';
        if (titleText) openTag += ' title="' + escapeText(titleText) + '"';
        openTag += '>';
        nodes[openerIdx] = rawNode(openTag, '');
        nodes.push(rawNode('</a>', ''));
        // note: closing tag pushed at end of nodes (content is everything
        // after the opener) — correct because ']' is the current position.
      }
    }
    if (armRegion && br.btPending > 0 && br.btTailInner % 2 === 1) {
      // a link whose text ends in an unterminated code span (with an
      // odd number of runs inside that span) leaves a region where
      // delimiter runs are inert. The region runs until the LAST
      // later backtick run of the pending length when one exists,
      // else the last later run of length 1; with neither, there is
      // no region at all.
      let p = endPos;
      let endLen = 0;
      let endPosRun = -1;
      while (p < n) {
        if (s[p] === '\\') { p += 2; continue; }
        if (s[p] === '`') {
          let m = 0;
          while (s[p + m] === '`') m++;
          if (m === br.btPending) { endLen = m; endPosRun = p; }
          else if (m === 1 && endLen === 0) endPosRun = p;
          p += m;
        } else p++;
      }
      if (endPosRun >= 0 && endLen === 0) endLen = 1;
      if (endLen > 0) { deadDelim = br.btPending; deadEnd = endPosRun; }
    }
    return endPos;
  }

  while (i < n) {
    const c = s[i];
    if (!INTERESTING.has(c)) {
      // plain run
      let j = i + 1;
      while (j < n && !INTERESTING.has(s[j])) j++;
      buf += s.slice(i, j);
      i = j;
      continue;
    }
    switch (c) {
      case '\\': {
        const nx = s[i + 1];
        if (nx === '\n') {
          // hard break (backslash at end of line); leading whitespace of
          // the next line is stripped
          flushBuf();
          nodes.push(rawNode('<br>', ''));
          i += 2;
          while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        } else if (nx !== undefined && ASCII_PUNCT.has(nx)) {
          if (nx === '&') {
            flushBuf();
            nodes.push(textNode('&'));
          } else {
            buf += nx;
          }
          i += 2;
        } else {
          buf += '\\';
          i++;
        }
        break;
      }
      case '\n': {
        // hard break if buf ends with 2+ spaces; leading whitespace of
        // the next line is stripped
        if (buf.endsWith('  ')) {
          buf = buf.replace(/ +$/, '');
          flushBuf();
          nodes.push(rawNode('<br>', ''));
          i++;
          while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        } else {
          buf += '\n';
          i++;
        }
        break;
      }
      case '`': {
        let run = 0;
        while (s[i + run] === '`') run++;
        // find closing run of exactly this length
        let j = i + run;
        let found = -1;
        while (j < n) {
          if (s[j] === '`') {
            let m = 0;
            while (s[j + m] === '`') m++;
            if (m === run) { found = j; break; }
            j += m;
          } else j++;
        }
        // inside a bracket, a code span may not cross the bracket's
        // closing ']' when the bracket's text passes the backtick
        // simulation (marked finds the ']' first in that case)
        if (found >= 0 && bracketStack.length > 0) {
          const top = bracketStack[bracketStack.length - 1];
          const textStart = top.srcIdx + (top.isImage ? 2 : 1);
          const cand = bracketCloseCandidate(textStart);
          if (cand >= 0 && found >= cand && linkTextBackticks(textStart, cand).v >= 0) {
            found = -1;
          }
        }
        if (deadDelim > 0 && deadEnd >= i &&
            deadEnd < (found >= 0 ? found + run : i + run)) {
          // the span starting here contains the region's last run:
          // the region ends and this span is lexed normally
          deadDelim = 0;
        }
        if (found < 0) {
          buf += '`'.repeat(run);
          i += run;
        } else {
          let content = s.slice(i + run, found).replace(/\n/g, ' ');
          if (content.length >= 2 && content[0] === ' ' &&
              content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
            content = content.slice(1, -1);
          }
          flushBuf();
          nodes.push(rawNode('<code>' + escapeCode(content) + '</code>', content));
          i = found + run;
        }
        break;
      }
      case '<': {
        const rest = s.slice(i);
        let handled = false;
        if (rest.startsWith('<!-->') || rest.startsWith('<!--->')) {
          // abruptly closed empty comments are complete comments in marked
          const len = rest.startsWith('<!-->') ? 5 : 6;
          flushBuf();
          nodes.push(rawNode(s.slice(i, i + len), ''));
          i += len;
          handled = true;
        } else if (rest.startsWith('<!--')) {
          const e = s.indexOf('-->', i + 4);
          if (e >= 0) {
            flushBuf();
            nodes.push(rawNode(s.slice(i, e + 3), ''));
            i = e + 3;
            handled = true;
          }
        } else if (rest.startsWith('<![CDATA[')) {
          const e = s.indexOf(']]>', i + 9);
          if (e >= 0) {
            flushBuf();
            nodes.push(rawNode(s.slice(i, e + 3), ''));
            i = e + 3;
            handled = true;
          }
        } else if (rest.startsWith('<?')) {
          const e = s.indexOf('?>', i + 2);
          if (e >= 0) {
            flushBuf();
            nodes.push(rawNode(s.slice(i, e + 2), ''));
            i = e + 2;
            handled = true;
          }
        } else if (/^<![A-Za-z]/.test(rest)) {
          const e = s.indexOf('>', i + 2);
          if (e >= 0) {
            flushBuf();
            nodes.push(rawNode(s.slice(i, e + 1), ''));
            i = e + 1;
            handled = true;
          }
        }
        if (!handled) {
          // autolink or tag
          const am = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
          const em = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/.exec(rest);
          if (am) {
            const url = am[1];
            const href = cleanUrl(url);
            flushBuf();
            if (href !== null) {
              nodes.push(rawNode('<a href="' + escapeText(href) + '">' + escapeText(url) + '</a>', url));
            } else {
              nodes.push(textNode(am[0]));
            }
            i += am[0].length;
          } else if (em) {
            const addr = em[1];
            flushBuf();
            nodes.push(rawNode('<a href="mailto:' + escapeText(addr) + '">' + escapeText(addr) + '</a>', addr));
            i += em[0].length;
          } else {
            const tag = scanHtmlTag(s, i);
            if (tag && tag.complete) {
              flushBuf();
              const tagText = s.slice(i, tag.end);
              // marked leaks its inLink state across the whole document:
              // an inline <a ...> tag suppresses extended autolinks until
              // an exact </a> is seen
              if (/^<a /i.test(tagText)) docState.inLinkTag = true;
              else if (/^<\/a>$/i.test(tagText)) docState.inLinkTag = false;
              nodes.push(rawNode(tagText, ''));
              i = tag.end;
            } else {
              buf += '<';
              i++;
            }
          }
        }
        break;
      }
      case '!': {
        if (s[i + 1] === '[') {
          flushBuf();
          const node = { k: 'open', image: true, html: '![', plain: '![', seq: NODE_SEQ++ };
          nodes.push(node);
          bracketStack.push({ node, isImage: true, active: true, srcIdx: i });
          i += 2;
        } else {
          buf += '!';
          i++;
        }
        break;
      }
      case '[': {
        flushBuf();
        const node = { k: 'open', image: false, html: '[', plain: '[', seq: NODE_SEQ++ };
        nodes.push(node);
        bracketStack.push({ node, isImage: false, active: true, srcIdx: i });
        i++;
        break;
      }
      case ']': {
        flushBuf();
        const r = tryLink(i);
        if (r < 0) {
          buf += ']';
          i++;
        } else {
          i = r;
        }
        break;
      }
      case '*':
      case '_':
      case '~': {
        let run = 0;
        while (s[i + run] === c) run++;
        if (deadDelim > 0) {
          // inert inside a dead region (see deadDelim above)
          buf += c.repeat(run);
          i += run;
          break;
        }
        if (c === '~' && run > 2) {
          buf += '~'.repeat(run);
          i += run;
          break;
        }
        const f = flanking(i, run);
        let canOpen;
        let canClose;
        if (c === '*') {
          canOpen = f.left;
          canClose = f.right;
        } else if (c === '_') {
          canOpen = f.left && (!f.right || isPunct(f.before));
          canClose = f.right && (!f.left || isPunct(f.after));
        } else {
          canOpen = f.left;
          canClose = f.right;
        }
        if (!canOpen && !canClose) {
          // a run that can neither open nor close is plain text
          buf += c.repeat(run);
          i += run;
          break;
        }
        flushBuf();
        const node = {
          k: 'delim', ch: c, len: run, runLen: run, open: '', close: '',
          plain: '', seq: NODE_SEQ++, pos: i,
        };
        nodes.push(node);
        delimStack.push({ node, ch: c, canOpen, canClose });
        i += run;
        break;
      }
      case '&': {
        const m = ENTITY_SHAPE.exec(s.slice(i, i + 64));
        if (m) {
          const ent = m[0];
          if (ent[1] === '#') {
            const decoded = decodeNumericEntity(s, i);
            if (decoded === null) {
              buf += '&';
              i++;
            } else {
              flushBuf();
              nodes.push({ k: 'text', html: escapeCode(decoded.text), plain: decoded.text, seq: NODE_SEQ++ });
              i = decoded.end;
            }
          } else if (deadDelim === 0 && /[*_~]/.test(ent)) {
            // a named reference whose text contains a delimiter run
            // only stands as an entity while that run stays unpaired;
            // if the run pairs as emphasis, the reference breaks into
            // ordinary text around the delimiter
            flushBuf();
            const parts = [];
            let j = 0;
            let hasDelim = false;
            while (j < ent.length) {
              const ch = ent[j];
              if (ch === '*' || ch === '_' || ch === '~') {
                let run = 0;
                while (ent[j + run] === ch) run++;
                const f = flanking(i + j, run);
                let canOpen;
                let canClose;
                if (ch === '_') {
                  canOpen = f.left && (!f.right || isPunct(f.before));
                  canClose = f.right && (!f.left || isPunct(f.after));
                } else {
                  canOpen = f.left;
                  canClose = f.right;
                }
                if ((canOpen || canClose) && !(ch === '~' && run > 2)) {
                  const dn = {
                    k: 'delim', ch, len: run, runLen: run, open: '', close: '',
                    plain: '', seq: NODE_SEQ++, pos: i + j,
                  };
                  parts.push({ delim: dn });
                  delimStack.push({ node: dn, ch, canOpen, canClose });
                  hasDelim = true;
                } else {
                  parts.push({ text: ch.repeat(run) });
                }
                j += run;
              } else {
                let k2 = j;
                while (k2 < ent.length && ent[k2] !== '*' && ent[k2] !== '_' && ent[k2] !== '~') k2++;
                parts.push({ text: ent.slice(j, k2) });
                j = k2;
              }
            }
            if (hasDelim) {
              nodes.push({ k: 'entity', raw: ent, plain: ent, parts, frozen: false, seq: NODE_SEQ++ });
            } else {
              nodes.push(rawNode(ent, ent));
            }
            i += ent.length;
          } else {
            flushBuf();
            nodes.push(rawNode(ent, ent));
            i += ent.length;
          }
        } else {
          buf += '&';
          i++;
        }
        break;
      }
      case '@': {
        if (!tryEmailAutolink()) {
          buf += '@';
          i++;
        }
        break;
      }
      default: {
        // possible GFM autolink prefix at a boundary
        const linked = tryExtendedAutolink();
        if (!linked) {
          buf += c;
          i++;
        }
        break;
      }
    }
  }
  flushBuf();
  processEmphasis(-1);

  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'delim') {
      out += nd.flip
        ? nd.ch.repeat(nd.len) + nd.close + nd.open
        : nd.close + nd.ch.repeat(nd.len) + nd.open;
    } else if (nd.k === 'entity') {
      const paired = !nd.frozen && nd.parts.some(p =>
        p.delim && (p.delim.open || p.delim.close || p.delim.len !== p.delim.runLen));
      if (!paired) {
        out += nd.raw;
      } else {
        for (const p of nd.parts) {
          if (p.delim) {
            const d = p.delim;
            out += d.flip
              ? d.ch.repeat(d.len) + d.close + d.open
              : d.close + d.ch.repeat(d.len) + d.open;
          } else {
            out += escapeText(p.text);
          }
        }
      }
    } else {
      out += nd.html;
    }
  }
  return out;

  // GFM email autolink at the '@' at position i. The local part is read
  // from the source (an escaped character inside it poisons the match),
  // an optional mailto:/xmpp: scheme directly before it is included, and
  // the domain must validate as a whole: one trailing '.' may be dropped,
  // but a domain ending in '-' or '_' (or with a bad label) kills it.
  // The local part may span inert delimiter nodes (a literal '_' or '~'
  // run) and the tail of the current text buffer.
  function tryEmailAutolink() {
    if (docState.inLinkTag) return false;
    // Local part: maximal run of [A-Za-z0-9.+_-] ending at the '@' in
    // the source. An escaped char belongs to an escape token, so the
    // run stops before it (the email starts after that token).
    let ls = i;
    while (ls > 0 && EMAIL_LOCAL_CHARS.has(s[ls - 1])) {
      const p = ls - 1;
      let bs = 0;
      let q = p - 1;
      while (q >= 0 && s[q] === '\\') { bs++; q--; }
      if (bs % 2 === 1) break;
      ls = p;
    }
    if (ls === i) return false;
    const runLocal = s.slice(ls, i);
    // The candidate (optional scheme + local) must sit verbatim at the
    // tail of the plain buffer; when the source run reaches back
    // across a token boundary (delimiter, escape, ...), only the
    // suffix of the run that lies inside the buffer can be the local
    // part. A scheme is rejected when an alphanumeric precedes it.
    let scheme = null;
    let local = null;
    let bufKeep = 0;
    for (let cand = runLocal; cand.length > 0 && scheme === null; cand = cand.slice(1)) {
      for (const sch of ['mailto:', 'xmpp:', '']) {
        const target = sch + cand;
        if (buf.length < target.length || !buf.endsWith(target)) continue;
        if (sch) {
          const prev = buf.length > target.length
            ? buf[buf.length - target.length - 1]
            : lastPlainChar();
          if (/[A-Za-z0-9]/.test(prev)) continue;
        }
        scheme = sch;
        local = cand;
        bufKeep = buf.length - target.length;
        break;
      }
    }
    if (scheme === null) return false;
    // Domain: maximal run of [A-Za-z0-9._-], cut back to the longest
    // prefix of dot-separated labels that each end in an alphanumeric
    // (regex-backtracking semantics); at least two labels are needed.
    let de = i + 1;
    while (de < n && /[A-Za-z0-9._-]/.test(s[de]) && !isCloserRunStart(de)) de++;
    const runDom = s.slice(i + 1, de);
    let used = 0;
    let labels = 0;
    let pos = 0;
    while (pos < runDom.length) {
      const dot = runDom.indexOf('.', pos);
      const lab = dot === -1 ? runDom.slice(pos) : runDom.slice(pos, dot);
      if (!/^[A-Za-z0-9_-]*[A-Za-z0-9]$/.test(lab)) break;
      labels++;
      used = dot === -1 ? runDom.length : dot;
      if (dot === -1) break;
      pos = dot + 1;
    }
    if (labels < 2) return false;
    const dom = runDom.slice(0, used);
    let endPos = i + 1 + used;
    let resource = '';
    if (scheme === 'xmpp:' && s[endPos] === '/') {
      let re = endPos + 1;
      while (re < n && /[A-Za-z0-9._~@-]/.test(s[re])) re++;
      if (re > endPos + 1) {
        resource = s.slice(endPos, re);
        endPos = re;
      }
    }
    const text = scheme + local + '@' + dom + resource;
    const href = scheme ? text : 'mailto:' + text;
    buf = buf.slice(0, bufKeep);
    flushBuf();
    const emNode = rawNode('<a href="' + escapeText(href) + '">' + escapeText(text) + '</a>', text);
    emNode.auto = true;
    nodes.push(emNode);
    i = endPos;
    return true;
  }

  // GFM extended autolinks starting at position i (c is s[i]).
  // Boundary for a 'www.' autolink (scheme URLs need none): the
  // candidate must start a token, or follow a text run whose last
  // character is whitespace or one of * _ ~ (. Any non-text token
  // (code span, link, image, break, tag) is a boundary by itself;
  // entity references count as text.
  function wwwBoundaryOk() {
    if (buf.length > 0) {
      const c = buf[buf.length - 1];
      return isWs(c) || '*_~('.includes(c);
    }
    const nd = nodes[nodes.length - 1];
    if (!nd) return true;
    if (nd.k === 'delim') return true;
    if (nd.k === 'open') return false;
    if (nd.k === 'text' || ((nd.k === 'raw' || nd.k === 'entity') && nd.plain.startsWith('&'))) {
      const p = nd.plain;
      if (!p) return true;
      const c = p[p.length - 1];
      return isWs(c) || '*_~('.includes(c);
    }
    return true;
  }

  function tryExtendedAutolink() {
    if (docState.inLinkTag) return false;
    const rest = s.slice(i);
    let kind = null;
    let prefixLen = 0;
    // the URL schemes match case-insensitively (href keeps the source
    // case); 'www.' is case-sensitive
    const head = rest.slice(0, 8).toLowerCase();
    if (rest.startsWith('www.')) { kind = 'www'; prefixLen = 4; }
    else if (head.startsWith('http://')) { kind = 'url'; prefixLen = 7; }
    else if (head.startsWith('https://')) { kind = 'url'; prefixLen = 8; }
    else if (head.startsWith('ftp://')) { kind = 'url'; prefixLen = 6; }
    else return false;
    if (kind === 'www' && !wwwBoundaryOk()) return false;
    // consume the URL (balanced-paren rules inside scanAutolinkUrl);
    // inside an open bracket the run stops before the closing ']' so
    // the bracket can close — if the link then fails, the node is
    // extended over the ']' (see tryLink)
    const capped = bracketStack.length > 0;
    const url = scanAutolinkUrl(i, capped);
    if (url.length <= prefixLen) return false;
    if (kind === 'www') {
      const host = url.slice(4).split('/')[0];
      if (!host.includes('.')) return false;
    }
    const href = kind === 'www' ? 'http://' + url : url;
    flushBuf();
    const auNode = rawNode('<a href="' + escapeText(cleanUrl(href) ?? href) + '">' + escapeText(url) + '</a>', url);
    auNode.auto = true;
    auNode.autoStart = i;
    auNode.autoKind = kind;
    auNode.autoCapEnd = capped ? i + url.length : -1;
    nodes.push(auNode);
    i = i + url.length;
    return true;
  }

  function lastPlainChar() {
    for (let k = nodes.length - 1; k >= 0; k--) {
      const p = nodes[k].plain;
      if (p) return p[p.length - 1];
      if (nodes[k].k === 'delim') return nodes[k].ch;
      if (nodes[k].k === 'open') return '[';
    }
    return '';
  }
}

// Trim an extended-autolink URL per GFM rules.
function trimAutolinkUrl(url) {
  let u = url;
  for (;;) {
    if (u.length === 0) break;
    const last = u[u.length - 1];
    if ('?!.,:*_~'.includes(last)) { u = u.slice(0, -1); continue; }
    if (last === ';') {
      // drop a trailing entity &...; if present
      const m = /&[A-Za-z0-9]+;$/.exec(u);
      if (m) { u = u.slice(0, u.length - m[0].length); continue; }
      u = u.slice(0, -1);
      continue;
    }
    if (last === ')') {
      // a trailing ')' is dropped when it is unmatched, or when the
      // group it closes itself contains a nested group
      let depth = 0;
      let match = -1;
      for (let k = u.length - 1; k >= 0; k--) {
        if (u[k] === ')') depth++;
        else if (u[k] === '(') {
          depth--;
          if (depth === 0) { match = k; break; }
        }
      }
      if (match === -1) { u = u.slice(0, -1); continue; }
      if (u.slice(match + 1, u.length - 1).includes('(')) {
        u = u.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return u;
}


// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function parse(markdown) {
  const src = String(markdown)
    .replace(/\r\n|\r/g, '\n')
    .replace(/\0/g, '\uFFFD');
  const eofNl = src.endsWith('\n');
  let lines = src.split('\n');
  if (eofNl) lines.pop();
  if (lines.length === 1 && lines[0] === '' && src === '') lines = [];
  const ctx = {
    defs: new Map(), eofNl, inList: false,
    indentLazy: null, breakAfter: null, forceContinue: null,
    defSpans: [],
  };
  const blocks = lexBlocks(lines, 0, lines.length, ctx);
  return renderBlocks(blocks, ctx.defs);
}
