# Sheet scripts (Copy of NONLOCAL PURCHASES)

A saved copy of the Apps Script code attached to **Copy of NONLOCAL PURCHASES** (Extensions → Apps Script),
taken on 7 Nov 2026. The project there is named "copy UNIT PURCHASE FMS".

| File | What it does |
|---|---|
| `Code.gs` | `copyDataToDoc` / `copyDatapart2`: makes the PO PDF from the **P.O** tab and logs it in **P.Os**. `checkAndStamp`: puts a date in column I when column J says "Approved". **Note:** in this sheet "Approved" is in column K, so this function likely does nothing here. It looks like it was written for UNIT PURCHASE FMS. |
| `macros.gs` | `SELECTALL` / `CLEARALL`: ticks or unticks A5:A54 |
| `material not recd.gs` | Emails the Material Not Received report |
| `invoice pending.gs` | Emails the Invoice Pending report |

**Trial vs live:** in this copy, the two report scripts read the **trial** sheet
(`1FYI-Mj44MXeu-YN4qiQMErPsm9jVE97vePxw3gu-QeY`). The live NONLOCAL PURCHASES sheet has its own copy of these
scripts. Those still read the live sheet, email the team, and were not changed. See [`../approval-app/GO-LIVE.md`](../approval-app/GO-LIVE.md).

Keep these files in step with the editor. If you change the code in Apps Script, paste the new version here too
(or ask Claude to). These are backup copies; the code that actually runs is the code in the Apps Script editor.
