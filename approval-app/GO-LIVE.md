# Going live: from the trial to the real sheet

**Right now (trial):** the approval app works on **Copy of NONLOCAL PURCHASES**
(`1FYI-Mj44MXeu-YN4qiQMErPsm9jVE97vePxw3gu-QeY`). The app shows a yellow **TRIAL** badge, and its
notifications start with **[TRIAL]**.

**When live:** it works on **NONLOCAL PURCHASES**
(`11B4bjVVFXyMXoTp8M22ROtMea55Hg0qRlAdzMVuIGJg`, owned by Ranish).

## Before you switch

- [ ] The trial has been tested end to end: HO assigns → approver gets a notification → approves, holds and
      rejects → columns J, K, M and N look right in the copy.
- [ ] **You have edit access to the live NONLOCAL PURCHASES sheet.** The server runs as you, so it can only write
      where you can write. Ask Ranish for **Editor** access.
- [ ] The live FMS tab has the same column layout as the copy: K = APPROVAL, L = APPROVER, M = APPROVED BY,
      N = QTY. **In the live sheet today, L is still called "APPROVED BY" and M is "CC APPROVAL".**
      Rename them, and copy the column L dropdown across, the same way you did in the copy.
- [ ] Agree a go-live time with HO and the approvers, so nobody keeps approving in the sheet by hand
      while the app is being switched over.

## The switch (about 10 minutes)

1. Open the **NLP Approvals** Apps Script project. At the top of the code, change
   ```js
   const MODE = 'TRIAL';
   ```
   to
   ```js
   const MODE = 'LIVE';
   ```
   and press **Ctrl+S**.
2. Run **`setup`** once. It creates the APP USERS, APP DEVICES and APP LOG tabs in the **live** sheet.
3. Copy the rows of the trial's **APP USERS** tab into the live sheet's **APP USERS** tab.
4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The web address stays the same, so
   nothing changes on anyone's phone.
5. **Phones:** everyone opens the app once and taps **Turn on notifications** again, because the phone list
   (APP DEVICES) starts empty on the live sheet. The yellow TRIAL badge will be gone.
6. Test with one real line, then tell everyone.

**Nothing else changes:** the app website, Firebase, Google sign-in and `config.js` all stay the same.

## Going back to the trial

Set `MODE = 'TRIAL'` and deploy a new version (step 4). The live sheet keeps everything the app wrote.

## The report scripts

The **Material Not Received** and **Invoice Pending** scripts in the *copy* point at the copy (trial).
The *live* sheet has its own copy of those scripts. They still point at the live sheet, still email the team,
and were never changed, so they need nothing at go-live. Backup copies of the trial versions are in
[`../sheet-scripts/`](../sheet-scripts/).
