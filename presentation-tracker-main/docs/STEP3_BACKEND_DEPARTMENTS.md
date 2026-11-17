# Step 3: Apps Script backend is department-aware

Only `apps-script/Code.gs` changed (plus tests). Frontend, database structure and docs other than this file are untouched.

## Request contract
Every list, submit and update names its department with `departmentId` (alias `dept`; `departmentId` wins if both are sent). Nothing sent = `medicine`, so the current Internal Medicine frontend works unchanged.

| Action | Department rule |
|---|---|
| `list` (GET) | Returns only that department's rows. |
| `submit` | The row is saved with the validated Department ID. |
| `update` | Succeeds only if the record's Department ID equals the requested one; otherwise `NOT_FOUND` (same message as a missing record). Department ID is never editable. |
| any | Unknown, inactive, malformed or non-text department → `UNKNOWN_DEPARTMENT`. Never falls back to "all data". |

Also scoped per department: the duplicate check, the retry cache (`requestId`) and the rate limit (one department's burst cannot block another).

## Unchanged
Readiness rules, PENDING/COMPLETED logic, Submission IDs, all fields, response shapes, locking, validation.

## Security limitations (public, no login)
- **Department ID is a label, not a credential.** The `/exec` URL is public. Anyone who calls it directly can name any ACTIVE department and read its list, register presentations, or edit/complete any record whose Submission ID they know. The checks prevent accidental cross-department mixing through the normal app; they do not stop a deliberate caller.
- Submission IDs are not secret (they are in every list response).
- No audit trail of who changed what; one shared script lock and Google quota for all departments.
- Student and consultant names are visible to anyone who can reach a department.
- Real separation needs an unguessable key per department checked by the backend, or sign-in (decision planned before other departments go live).
- `ping` still reports only the service name and schema version.

## Run the tests
`node tests/step2-simulation.js` (40 checks) and `node tests/step3-simulation.js` (35 checks): the real `Code.gs` against an in-memory imitation of Google Sheets, not real Google Sheets.

## Deploying
Paste the new `Code.gs`, run `runSelfTest`, then Deploy → Manage deployments → edit → New version. (Step 2 migration must already have been run.)
