# Step 8: Download list (PDF / Excel)

A **Download list** row sits under the search tools on every department tracker: a category menu and two buttons, **PDF** and **Excel**. It saves what is already on the page, so nothing new is requested from the backend and nothing is stored.

## Categories
The menu names match the page's own sections and show their current counts, for example `Ready presentations (16)`.

| Menu | Contains |
|---|---|
| All presentations | every presentation of this department |
| Pending presentations | not completed yet (ready + unready) |
| Ready presentations | pending and ready (the "Ready Presentations" section) |
| Unready presentations | pending and unready (the "Unready Presentations" section) |
| Completed presentations | completed |

Downloads are **organised by status**, in the page's own order: Ready, then Unready, then Completed (only the groups that have rows). Inside each group rows are listed by planned date, then time, and the numbering restarts at 1. The search box and the Overview filter do not change what is downloaded; the category menu does. An empty category shows a message and no file is made.

## The files
File name: `<department>-<category>-presentations-YYYY-MM-DD.pdf` / `.xlsx` (for example `medicine-ready-presentations-2026-11-17.xlsx`).

- **PDF**: A4 landscape. Title, department and category, count and date, then a table with a shaded heading for each status (for example `Ready presentations (16)`): No., Topic (with the challenge note under it for unready ones), Presenter, Date and time, Supervisor, Consultant, Availability, Status. The table header repeats on every page; each page has "Page n of N". Standard PDF fonts are used, so letters outside Western European languages are shown as `?`.
- **Excel**: a real `.xlsx` with **one sheet per status** (`Ready presentations`, `Unready presentations`, `Completed presentations`; a single-category download has one sheet). Each sheet has these columns: No., Topic, Presenter, Date (a real date, sortable), Time, Supervisor, Consultant, Consultant availability, Readiness, Progress, Challenge. Header row frozen and filterable. Everything is stored as text, so a topic that starts with `=` stays text and is never run as a formula.

## How it works
`js/export.js` (new, loaded after `dashboard.js`) builds both files in the browser with no libraries (a small PDF writer and a small ZIP writer for the `.xlsx`), then saves them with a normal download. `dashboard.js` calls `updateExportCounts()` after each render to refresh the counts. `css/style.css` has the `.export-bar` rules (appended). `index.html` has the new row and the script tag. The Content-Security-Policy is unchanged: no new hosts.

## Tests
`node tests/step8-export.js`: 54 checks (menu and counts, Excel and PDF for each category, escaping, dates, empty category). The `.xlsx` files were also opened with openpyxl and the PDFs read with `pdftotext` and rendered with `pdftoppm` during development. Not tested in Excel itself, Preview/Acrobat, or on a real phone: open one file of each kind after publishing.
