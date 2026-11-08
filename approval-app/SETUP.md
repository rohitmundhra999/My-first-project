# NLP Approvals – setup guide

A phone app for approving non-local purchase requisitions.

> **This is the trial.** It runs on **Copy of NONLOCAL PURCHASES** and shows a yellow **TRIAL** badge.
> To move it to the real NONLOCAL PURCHASES sheet later, follow [`GO-LIVE.md`](GO-LIVE.md). It's one setting, `MODE`.

**How it works**
1. **HO in-charge** opens the app, ticks the new requisition lines and picks an approver. The app writes the
   name into **FMS column L (APPROVER)**.
2. That approver gets a **notification on their phone** (or an email, if they haven't turned notifications on yet).
3. The approver opens the app, can change the **quantity**, and taps **Approve / Hold / Reject / Withdraw**.
   The app writes **K (APPROVAL)**, **M (APPROVED BY)** = their name, **N (QTY)**, and **J (ACTUAL)** = the time.
4. **Only the person named in column L can decide that line.** The server checks this using the
   @summithotels.in Google account each person signed in with. Every action is recorded in the **APP LOG** tab.

Parts: `apps-script/Approvals.gs` is the server (Google Apps Script). The rest of this folder is the app that
people install on their phones (hosted free on GitHub Pages). Notifications go through Firebase (free).

You only do this setup once. It takes about 30–40 minutes.

---

## Step 1 – The server (Apps Script)

1. Go to **script.google.com** → **New project**. Rename it **NLP Approvals**.
   *(Use a new project. Don't add this to the sheet's existing script, where the names could clash.)*
2. Delete everything in `Code.gs` and paste in the full contents of `apps-script/Approvals.gs`. Press **Ctrl+S**.
3. In the function dropdown at the top, choose **`setup`** and click **Run**. Allow the permissions it asks for.
   This adds three tabs to Copy of NONLOCAL PURCHASES:
   - **APP USERS**: who can use the app. It starts with the 7 names from the column L dropdown.
   - **APP DEVICES**: phones with notifications on. The app fills this in, so don't edit it.
   - **APP LOG**: every assignment and decision, with the person's email and the time.
4. Open the **APP USERS** tab and fill it in:

   | Name (exactly as in column L) | Email | Role | Active |
   |---|---|---|---|
   | Niharika Mitruka | niharika@summithotels.in | APPROVER | YES |
   | Rohit Mundhra | rohit@summithotels.in | HO+APPROVER | YES |
   | *(HO person)* | ho.purchase@summithotels.in | HO | YES |

   - **Role**: `HO` assigns approvers, `APPROVER` approves, `HO+APPROVER` does both.
   - The approver's **Name must be spelled exactly as in the column L dropdown**. When you add a new approver,
     add their name to that dropdown as well (Data → Data validation on column L).
   - To remove someone, set **Active** to `NO`.
5. Click **Deploy** → **New deployment** → the ⚙️ next to "Select type" → **Web app**:
   - Description: `NLP Approvals`
   - Execute as: **Me**
   - Who has access: **Anyone**. This is safe: every request must carry a valid @summithotels.in Google
     sign-in, and the person must be in APP USERS.
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

## Step 2 – Firebase (for notifications)

1. Go to **console.firebase.google.com** → **Create a project** → name it `nlp-approvals` (Google Analytics: off).
2. Click ⚙️ **Project settings** → **General** → under "Your apps" click the **web icon `</>`** → nickname
   `NLP Approvals` → **Register app**. Copy the `firebaseConfig` block it shows.
3. **Project settings → Cloud Messaging** → **Web Push certificates** → **Generate key pair**. Copy the key.
4. **Project settings → Service accounts** → **Generate new private key**. A `.json` file downloads.
   - **This file is a password. Don't send it to anyone, including me.**
   - Open it in Notepad and copy everything.
   - In the Apps Script project: ⚙️ **Project Settings** → **Script properties** → **Add script property**:
     name `FIREBASE_SERVICE_ACCOUNT`, value = everything you copied. Save.
   - Delete the downloaded file.

## Step 3 – Google sign-in

1. Go to **console.cloud.google.com**. At the top, select the **nlp-approvals** project (Firebase created it).
2. **APIs & Services → OAuth consent screen** → User type **Internal** → app name `NLP Approvals`, your email → Save.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**, name `NLP Approvals`
   - **Authorized JavaScript origins**: `https://rohitmundhra999.github.io`
   - Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).
4. Back in Apps Script → **Project Settings → Script properties**, add two more:
   - `GOOGLE_CLIENT_ID` = the Client ID
   - `APP_URL` = `https://rohitmundhra999.github.io/My-first-project/approval-app/`

## Step 4 – Put the app online

1. **Send me these four values** (none of them is secret), and I'll put them into `config.js` for you:
   - the Web app URL (Step 1.5)
   - the `firebaseConfig` block (Step 2.2)
   - the Web Push key (Step 2.3)
   - the Client ID (Step 3.3)
2. On GitHub: **My-first-project → Settings → Pages** → Source **Deploy from a branch** → branch
   `claude/nonlocal-purchase-dashboard-62yab4` (or `main` once merged), folder **/ (root)** → Save.
   After a minute the app is live at `https://rohitmundhra999.github.io/My-first-project/approval-app/`.
   *(If the repository is private, GitHub Pages needs a paid GitHub plan. Otherwise make the repository public.
   It only holds code, not your purchase data.)*

## Step 5 – Install on phones

- **Android (Chrome):** open the link → **Sign in** → **Turn on notifications** → ⋮ menu → **Add to Home screen / Install app**.
- **iPhone (Safari, iOS 16.4 or newer):** open the link → **Share** → **Add to Home Screen** → open the app
  **from the new icon** → **Sign in** → **Turn on notifications**. iPhones only allow notifications
  for apps opened from the Home Screen.

**Test:** once your own phone has notifications on, run **`testNotification`** in the Apps Script editor.
Your phone should buzz within a few seconds.

---

## Good to know

- **Changing the server code later:** paste the new code, then **Deploy → Manage deployments → ✏️ edit →
  Version: New version → Deploy**. The URL stays the same.
- **Which lines show up:** only lines requested in the last 120 days (`LOOKBACK_DAYS` at the top of the code).
  HO sees lines with no decision yet. Approvers see lines assigned to them that are undecided or On Hold.
- **Column J (ACTUAL)** currently holds `=now()`, so it always shows the current time. The app replaces it
  with the real decision time on every line it decides.
- **The app writes to the sheet as you (Rohit)**, because the server runs as you. The **APP LOG** tab and the
  **APPROVED BY** column show who actually did it.
- **Moving to the live NONLOCAL PURCHASES sheet later:** change `SHEET_ID` at the top of the code. This needs
  edit access to that sheet (owned by Ranish).

## Admin preview ("View app as") and Reports

- **View app as:** the admin sees a **View app as** box under the header and can pick anyone in APP USERS
  to see the app exactly as they see it. The preview is **read-only**: nothing can be assigned, approved or
  registered while previewing, so the sheet and APP LOG always show the real person.
  The admin is the person the server runs as (Rohit). To make someone else an admin too, add `ADMIN` to
  their Role in APP USERS, for example `HO+APPROVER+ADMIN`.
- **Reports tab (everyone in APP USERS):** live **Material not received** and **Invoice pending**, using
  the same rules as the daily emails (approved POs from 1 Apr 2026, same PO counted once, Central Store left
  out). Filters: cluster, unit, month, age (over 7/15/30/60 days) and search. Two views: PO list, and
  Unit × month counts (tap a number to see those POs). The sheet is re-read at most every 2 minutes.
- **Approver notifications** are sent both when HO picks the approver in the app and when someone picks a
  name in FMS column L directly (after running `installFmsTrigger` once). The app's own writes don't fire
  the sheet trigger, so nobody gets two notifications for the same assignment.
