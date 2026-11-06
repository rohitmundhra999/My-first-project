# Non-Local Purchase Dashboard

A browser dashboard for the **NONLOCAL PURCHASES** tracker (the `FMS` tab). It follows each requisition line through
**requisition → approval → PO → material/invoice received → payment** and shows:

- **KPIs**: requisition lines, approved, on hold / pending, awaiting PO, POs raised, PO value, overdue deliveries, received / paid
- **Charts**: pipeline, monthly trend (lines or PO value), by unit, top vendors, by category. Click a bar to filter by it.
- **Turnaround**: % of POs raised on time, % delivered on time, average days from requisition to PO and from PO to receipt
- **Action lists**: overdue deliveries (sorted by days late), approved lines with no PO, on-hold / pending lines, and all lines
- **Filters**: period (this month, last 30/90 days, this financial year, custom), unit, category, vendor, stage, and search
- **Export CSV** of whatever is currently filtered

There is no server, build step or login. Everything runs in the browser, and the data never leaves it.

## Run it

Open `index.html` in a browser. To share it with the team, turn on **GitHub Pages** for this repo
(Settings → Pages → Deploy from branch → `main` / root) and send them the link.

## Load data

Click **Load data** and pick one of these:

1. **Upload a file**: download the `FMS` tab as `.xlsx` or `.csv` and choose it. For an `.xlsx` the app picks the `FMS` sheet by itself.
   The data is kept in your browser, so it is still there next time you open the page.
2. **Connect a Google Sheet** (live, with a **Refresh** button):
   The NONLOCAL PURCHASES sheet is owned by someone else, so mirror it into a sheet you own:
   1. Create a new Google Sheet.
   2. In cell `A1` enter `=IMPORTRANGE("11B4bjVVFXyMXoTp8M22ROtMea55Hg0qRlAdzMVuIGJg", "FMS!A1:AO")` and click **Allow access**.
   3. Go to **File → Share → Publish to web**, choose that tab and **Comma-separated values (.csv)**, then click **Publish**.
   4. Paste the published link into the dashboard and click **Connect**. The link is remembered, so later just press **Refresh**.

   A sheet shared as "Anyone with the link can view" also works if you paste its normal URL (include `#gid=` for the FMS tab).
   ⚠️ Either way, anyone who has that link can read the data.
3. **Use demo data**: loads made-up sample data so you can try the dashboard.

## How the FMS columns are read

The app looks for the header row that has `ORDER NO` followed by `TIMESTAMP`, and reads the other columns by their
position after it (same layout as the FMS tab):

| Stage | Rule |
|---|---|
| Rejected / withdrawn | APPROVAL is Rejected or Withdrawn |
| On hold | APPROVAL is On Hold |
| Awaiting approval | APPROVAL is blank and there is no PO |
| Awaiting PO | Approved, but P.O NO. is blank |
| Awaiting delivery | Has a PO, but the receipt date, RECEIVED qty and INVOICE NUMBER are all blank |
| Received | Material/invoice received, no payment date or transaction details yet |
| Paid | Payment ACTUAL date or TRANSACTION DETAILS filled in |

- **Overdue delivery** means it is still awaiting delivery after the planned date (PO date + delivery days).
- **PO value**: the AMOUNT column holds the PO total, repeated on every line of that PO. It is counted **once per PO number**.
- **Years**: timestamps like `22-06(16:33)` have no year. Rows are in time order, so the app counts back from the newest
  row (this year) and moves to the previous year whenever the month jumps back, e.g. from January to the previous December.
- Placeholder values such as `UPDATE` or `#REF!` are ignored.

If the FMS columns move, update the `C` offsets at the top of `app.js`.

## Files

- `index.html`: page layout
- `styles.css`: styling (light and dark themes, works on phones)
- `app.js`: parsing, filters, charts and tables. Uses Chart.js and SheetJS from cdnjs.
