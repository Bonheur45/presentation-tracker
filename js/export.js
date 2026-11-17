/*
 * export.js — "Download list": the presentations of one category as a PDF or an Excel (.xlsx) file.
 * Loaded after dashboard.js. No libraries and no network: both files are built in the browser from the list
 * that is already on the page (the same records the cards show), so nothing new is requested from the backend.
 *
 * Categories match the page's own sections:
 *   all        every presentation
 *   pending    not completed yet (ready + unready)
 *   ready      pending and ready          (the "Ready Presentations" section)
 *   unready    pending and unready        (the "Unready Presentations" section)
 *   completed  completed                  (the "Completed Presentations" section)
 * Rows are grouped by status (Ready, Unready, Completed: the page's own order), then listed by planned date and time.
 * PDF: one headed section per status. Excel: one sheet per status.
 *
 * Uses from dashboard.js: presentations, hasLoaded, isReady, isCompleted, formatDate, formatPlannedTime,
 * AVAILABILITY, showToast. Uses window.DEPARTMENT (department.js) for the title and the file name.
 */
(function () {
  "use strict";

  const CATEGORIES = {
    all:       { label: "All presentations",       file: "all",       pick: list => list },
    pending:   { label: "Pending presentations",   file: "pending",   pick: list => list.filter(p => !isCompleted(p)) },
    ready:     { label: "Ready presentations",     file: "ready",     pick: list => list.filter(p => !isCompleted(p) && isReady(p)) },
    unready:   { label: "Unready presentations",   file: "unready",   pick: list => list.filter(p => !isCompleted(p) && !isReady(p)) },
    completed: { label: "Completed presentations", file: "completed", pick: list => list.filter(isCompleted) }
  };

  const selectEl = document.getElementById("filter");          // the overview's "Sort by" menu: the list that is shown is the list that is downloaded
  const pdfBtn = document.getElementById("export-pdf");
  const xlsxBtn = document.getElementById("export-xlsx");
  if (!selectEl || !pdfBtn || !xlsxBtn) return;

  /* ---------------- the rows ---------------- */

  function departmentTitle() {
    const d = window.DEPARTMENT;
    if (!d) return "Presentations";
    return d.org ? `${d.name}, ${d.org}` : d.name;
  }

  function rowsFor(category) {
    const sorted = CATEGORIES[category].pick(presentations.slice()).sort((a, b) =>
      String(a.date).slice(0, 10).localeCompare(String(b.date).slice(0, 10)) ||
      String(a.time).localeCompare(String(b.time)) ||
      String(a.topic).localeCompare(String(b.topic)));
    return sorted.map((p, i) => {
      const done = isCompleted(p);
      const a = AVAILABILITY[p.availability] || { label: p.availability || "Unknown" };
      return {
        no: i + 1,
        topic: p.topic,
        student: p.student,
        dateISO: String(p.date).slice(0, 10),
        dateText: formatDate(p.date),
        timeText: p.time ? formatPlannedTime(p.time) : "",
        supervisor: p.supervisor,
        consultant: p.consultant,
        availability: a.label,
        readiness: isReady(p) ? "Ready" : "Unready",
        progress: done ? "Completed" : "Pending",
        status: done ? "Completed" : (isReady(p) ? "Ready" : "Unready"),
        challenge: done ? "" : String(p.challenge || "")
      };
    });
  }

  // The rows of a category split by status, in the page's order. Numbering restarts in each group.
  function groupsFor(category) {
    const rows = rowsFor(category);
    return [["Ready", "Ready presentations"], ["Unready", "Unready presentations"], ["Completed", "Completed presentations"]]
      .map(d => {
        const list = rows.filter(r => r.status === d[0]);
        list.forEach((r, i) => { r.no = i + 1; });
        return { status: d[0], label: d[1], rows: list };
      })
      .filter(g => g.rows.length);
  }

  function fileName(category, ext) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dept = window.DEPARTMENT && window.DEPARTMENT.id ? window.DEPARTMENT.id : "department";
    return `${dept}-${CATEGORIES[category].file}-presentations-${day}.${ext}`;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------------- Excel (.xlsx) ---------------- */

  const xmlEsc = s => String(s == null ? "" : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // A minimal ZIP writer (entries stored, not compressed): all an .xlsx needs.
  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  const colName = i => String.fromCharCode(65 + i);               // 0 → A … (fewer than 26 columns)
  const xlDate = iso => {                                         // days since 1899-12-30, or null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null;
  };

  function buildXlsx(category, groups) {
    const columns = [
      { head: "No.", w: 6 }, { head: "Topic", w: 44 }, { head: "Presenter", w: 24 }, { head: "Date", w: 14 }, { head: "Time", w: 11 },
      { head: "Supervisor", w: 24 }, { head: "Consultant", w: 24 }, { head: "Consultant availability", w: 22 },
      { head: "Readiness", w: 12 }, { head: "Progress", w: 12 }, { head: "Challenge", w: 46 }
    ];
    const text = (ref, s, style) => `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(s)}</t></is></c>`;
    const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const sheetXml = (rows) => {
    let sheet = "";
    sheet += `<row r="1" ht="30" customHeight="1">${columns.map((c, i) => text(colName(i) + "1", c.head, 1)).join("")}</row>`;
    rows.forEach((r, k) => {
      const n = k + 2, serial = xlDate(r.dateISO);
      sheet += `<row r="${n}">` +
        `<c r="A${n}" s="2"><v>${r.no}</v></c>` +
        text("B" + n, r.topic, 2) + text("C" + n, r.student, 2) +
        (serial === null ? text("D" + n, r.dateText, 2) : `<c r="D${n}" s="3"><v>${serial}</v></c>`) +
        text("E" + n, r.timeText, 2) + text("F" + n, r.supervisor, 2) + text("G" + n, r.consultant, 2) +
        text("H" + n, r.availability, 2) + text("I" + n, r.readiness, 2) + text("J" + n, r.progress, 2) + text("K" + n, r.challenge, 2) +
        `</row>`;
    });
    return head + `<worksheet xmlns="${MAIN}">` +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"/>`).join("")}</cols>` +
        `<sheetData>${sheet}</sheetData></worksheet>`;
    };
    const sheetNames = groups.map(g => g.label.replace(/[\[\]:*?\/\\]/g, "").slice(0, 31));
    const count = groups.length;

    return zip([
      { name: "[Content_Types].xml", text: head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        groups.map((g, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: "_rels/.rels", text: head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", text: head + `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${sheetNames.map((nm, i) => `<sheet name="${xmlEsc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", text: head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        groups.map((g, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${count + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/styles.xml", text: head + `<styleSheet xmlns="${MAIN}">` +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\ mmm\\ yyyy"/></numFmts>' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FF173C32"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    ].concat(groups.map((g, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(g.rows) }))));
  }

  /* ---------------- PDF ---------------- */

  // Helvetica character widths (1/1000 em) for ASCII 32–126; accented letters use their base letter's width.
  const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
    1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
    333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const WIN1252 = { 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2013: 0x96, 0x2014: 0x97, 0x2026: 0x85, 0x2022: 0x95, 0x20AC: 0x80 };

  // Text → a string of single-byte (WinAnsi) characters; anything the standard PDF font cannot show becomes "?".
  function winAnsi(s) {
    let out = "";
    for (const ch of String(s == null ? "" : s).normalize("NFC")) {
      const c = ch.codePointAt(0);
      if (WIN1252[c]) out += String.fromCharCode(WIN1252[c]);
      else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out += ch;
      else if (c === 9 || c === 10 || c === 13) out += " ";
      else if (c >= 0x300 && c <= 0x36F) continue;               // stray combining marks
      else out += "?";
    }
    return out;
  }

  function charWidth(code, bold) {
    let w;
    if (code >= 32 && code <= 126) w = HELV[code - 32];
    else if (code >= 192 && code <= 255) {
      const base = String.fromCharCode(code).normalize("NFD").charCodeAt(0);
      w = base >= 32 && base <= 126 ? HELV[base - 32] : 556;
    } else w = 556;
    return bold ? w * 1.07 : w;
  }
  const textWidth = (s, size, bold) => { let w = 0; for (let i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i), bold); return w * size / 1000; };

  // Breaks text into lines no wider than maxW (long words are split).
  function wrap(text, size, bold, maxW) {
    const lines = [];
    String(text).split(/\n/).forEach(par => {
      let line = "";
      par.split(" ").forEach(word => {
        while (textWidth(word, size, bold) > maxW) {                        // a single word wider than the cell
          let cut = word.length - 1;
          while (cut > 1 && textWidth(word.slice(0, cut), size, bold) > maxW) cut--;
          if (line) { lines.push(line); line = ""; }
          lines.push(word.slice(0, cut)); word = word.slice(cut);
        }
        const trial = line ? line + " " + word : word;
        if (line && textWidth(trial, size, bold) > maxW) { lines.push(line); line = word; } else line = trial;
      });
      lines.push(line);
    });
    return lines;
  }

  const PW = 842, PH = 595, MARGIN = 36, SIZE = 8.5, LEAD = 11, PADX = 4, PADY = 4, HEAD_H = 20;
  const GREEN = [0.09, 0.235, 0.196], INK = [0.125, 0.16, 0.137], MUTED = [0.47, 0.51, 0.49];
  const STATUS_COLOR = { Ready: [0.15, 0.5, 0.31], Unready: [0.71, 0.28, 0.28], Completed: [0.35, 0.4, 0.37] };
  const num = n => String(Math.round(n * 100) / 100);
  const pdfEsc = s => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  function buildPdf(category, groups) {
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    const columns = [
      { head: "No.", w: 24 }, { head: "Topic", w: 200 }, { head: "Presenter", w: 100 }, { head: "Date and time", w: 82 },
      { head: "Supervisor", w: 100 }, { head: "Consultant", w: 100 }, { head: "Availability", w: 88 }, { head: "Status", w: 76 }
    ];
    const title = "Medical Students Presentation Tracker";
    const subtitle = `${departmentTitle()}: ${CATEGORIES[category].label}`;
    const stamp = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const meta = `${total} ${total === 1 ? "presentation" : "presentations"}, grouped by status and listed by planned date. Generated ${stamp}.`;

    const pages = [];
    let ops = null, y = 0;
    const text = (x, base, s, font, size, color) =>
      ops.push(`BT /${font} ${num(size)} Tf ${color.map(num).join(" ")} rg ${num(x)} ${num(PH - base)} Td (${pdfEsc(s)}) Tj ET`);
    const rect = (x, top, w, h, color) => ops.push(`${color.map(num).join(" ")} rg ${num(x)} ${num(PH - top - h)} ${num(w)} ${num(h)} re f`);
    const rule = (x1, x2, at, color) => ops.push(`${color.map(num).join(" ")} RG 0.5 w ${num(x1)} ${num(PH - at)} m ${num(x2)} ${num(PH - at)} l S`);

    function tableHead() {
      rect(MARGIN, y, PW - 2 * MARGIN, HEAD_H, GREEN);
      let x = MARGIN;
      columns.forEach(c => { text(x + PADX, y + 13, winAnsi(c.head), "F3", 8, [1, 1, 1]); x += c.w; });
      y += HEAD_H;
    }
    function newPage() {
      ops = []; pages.push(ops); y = MARGIN;
      if (pages.length === 1) {
        text(MARGIN, y + 14, winAnsi(title), "F3", 15, GREEN);
        text(MARGIN, y + 31, winAnsi(subtitle), "F1", 10.5, INK);
        text(MARGIN, y + 45, winAnsi(meta), "F1", 8.5, MUTED);
        y += 58;
      } else {
        text(MARGIN, y + 8, winAnsi(`${title}: ${subtitle}`), "F1", 8, MUTED);
        y += 18;
      }
      tableHead();
    }
    newPage();

    const BAND = [0.91, 0.95, 0.93], BAND_H = 18;
    function groupBand(g) {
      if (y + BAND_H + 44 > PH - 44) newPage();            // never leave a heading alone at the bottom of a page
      rect(MARGIN, y, PW - 2 * MARGIN, BAND_H, BAND);
      text(MARGIN + PADX, y + 12.5, winAnsi(`${g.label} (${g.rows.length})`), "F3", 9, STATUS_COLOR[g.status] || INK);
      y += BAND_H;
    }

    groups.forEach(g => { groupBand(g); g.rows.forEach(r => {
      // each cell is a list of { lines, font, color } blocks
      const cells = [
        [{ t: String(r.no), f: "F1", c: INK }],
        [{ t: r.topic, f: "F3", c: INK }].concat(r.challenge ? [{ t: "Challenge: " + r.challenge, f: "F2", c: MUTED }] : []),
        [{ t: r.student, f: "F1", c: INK }],
        [{ t: r.dateText, f: "F1", c: INK }].concat(r.timeText ? [{ t: r.timeText, f: "F1", c: MUTED }] : []),
        [{ t: r.supervisor, f: "F1", c: INK }],
        [{ t: r.consultant, f: "F1", c: INK }],
        [{ t: r.availability, f: "F1", c: INK }],
        [{ t: r.status, f: "F3", c: STATUS_COLOR[r.status] || INK }]
      ].map((blocks, i) => blocks.map(b => {
        const bold = b.f === "F3";
        return { lines: wrap(winAnsi(b.t), SIZE, bold, columns[i].w - 2 * PADX - 1), f: b.f, c: b.c };
      }));
      const lineCount = Math.max(...cells.map(blocks => blocks.reduce((n, b) => n + b.lines.length, 0)));
      const height = lineCount * LEAD + 2 * PADY;
      if (y + height > PH - 44) newPage();
      let x = MARGIN;
      cells.forEach((blocks, i) => {
        let k = 0;
        blocks.forEach(b => b.lines.forEach(line => { text(x + PADX, y + PADY + 8 + k * LEAD, line, b.f, SIZE, b.c); k++; }));
        x += columns[i].w;
      });
      y += height;
      rule(MARGIN, PW - MARGIN, y, [0.86, 0.89, 0.87]);
    }); });

    if (!total) { text(MARGIN + PADX, y + 16, "No presentations in this category.", "F2", 9, MUTED); }

    // footer on every page, now that the page count is known
    pages.forEach((p, i) => {
      ops = p;
      text(MARGIN, PH - 22, winAnsi(`${departmentTitle()}  |  ${stamp}`), "F1", 7.5, MUTED);
      const label = `Page ${i + 1} of ${pages.length}`;
      text(PW - MARGIN - textWidth(label, 7.5, false), PH - 22, label, "F1", 7.5, MUTED);
    });

    // assemble the file: 1 catalog, 2 page tree, 3–5 fonts, then (page, content) pairs
    const body = [];
    const font = (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
    body[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    body[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`;
    body[3] = font("Helvetica"); body[4] = font("Helvetica-Oblique"); body[5] = font("Helvetica-Bold");
    pages.forEach((p, i) => {
      const stream = p.join("\n");
      body[6 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${7 + 2 * i} 0 R >>`;
      body[7 + 2 * i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    let out = "%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n";
    const offsets = [];
    for (let id = 1; id < body.length; id++) { offsets[id] = out.length; out += `${id} 0 obj\n${body[id]}\nendobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${body.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${body.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return new Blob([bytes], { type: "application/pdf" });
  }

  /* ---------------- the controls ---------------- */

  function run(kind) {
    if (!hasLoaded) { showToast("The list is still loading. Try again in a moment.", "error"); return; }
    const category = CATEGORIES[selectEl.value] ? selectEl.value : "all";
    const groups = groupsFor(category);
    if (!groups.length) { showToast(`There are no ${CATEGORIES[category].label.toLowerCase()} to download yet.`, "error"); return; }
    try {
      if (kind === "pdf") { saveBlob(buildPdf(category, groups), fileName(category, "pdf")); showToast("PDF downloaded."); }
      else { saveBlob(buildXlsx(category, groups), fileName(category, "xlsx")); showToast("Excel file downloaded."); }
    } catch (err) {
      showToast("Could not create the file. Please try again.", "error");
    }
  }

  pdfBtn.addEventListener("click", () => run("pdf"));
  xlsxBtn.addEventListener("click", () => run("xlsx"));
})();
