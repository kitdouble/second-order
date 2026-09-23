# One-time setup (no terminal)

About an hour of clicking, done once. After this, every push to `main` goes
live on its own. Google's console layouts change often, so if a button has
moved, search for its name in the console's search bar.

You need: a Google account, a credit card for Google Cloud billing (usage
should stay in the free tiers, and step 3 sets an alert in case it doesn't),
and access to the DNS settings where you bought 2ndorder.live.

---

## 1. Put the code on GitHub

1. Install **GitHub Desktop** (desktop.github.com) and sign in.
2. **File → Add local repository**, choose the unzipped `second-order` folder.
   It is already a git repository on branch `main`.
3. Click **Publish repository**. Keep **Private** ticked.

From now on, "push to main" means: commit in GitHub Desktop, then **Push origin**.
Claude Code can also push for you.

## 2. Create the Google Cloud project

1. Go to console.cloud.google.com → project picker → **New project**.
   Name it `second-order`. Note the **Project ID** it shows (for example
   `second-order-123456`).
2. **Billing**: link a billing account to the project when asked.
3. Turn on the services the pipeline uses. Open this link, check the project
   selected at the top is `second-order`, and click **Enable**:

   https://console.cloud.google.com/flows/enableapi?apiid=run.googleapis.com,cloudbuild.googleapis.com,artifactregistry.googleapis.com,firebasehosting.googleapis.com,secretmanager.googleapis.com,iam.googleapis.com,serviceusage.googleapis.com

## 3. Set a budget alert

**Billing → Budgets & alerts → Create budget**. Scope: this project. Amount:
A$20 a month. Alerts at 50%, 90% and 100%. This only emails you; it doesn't
stop anything, but it means a surprise can't run for a month unnoticed.

## 4. Add Firebase to the same project

1. Go to console.firebase.google.com → **Create a project** → choose
   **add Firebase to an existing Google Cloud project** and pick `second-order`.
   You can turn Google Analytics off.
2. In the left menu: **Build → Hosting → Get started**. Click through the
   screens; you don't need to run the commands they show. The pipeline does that.

## 5. Create the deploy account

The pipeline runs as its own account with only the permissions it needs.

1. **IAM & Admin → Service accounts → Create service account**.
   Name: `so-deployer`. Click **Create and continue**.
2. Grant these roles (use **Add another role** for each):
   - Cloud Build Service Account
   - Cloud Run Admin
   - Service Account User
   - Artifact Registry Administrator
   - Firebase Hosting Admin
   - Secret Manager Viewer
   - Service Usage Consumer
3. Click **Done**.

## 6. Connect GitHub and create the trigger

1. **Cloud Build → Triggers**. Set the region at the top to
   **australia-southeast1 (Sydney)**.
2. **Connect repository** → **GitHub** → authorise → install the Google Cloud
   Build app on your GitHub account, giving it access to the `second-order`
   repository only → select it → **Connect**.
3. **Create trigger**:
   - Name: `deploy-main`
   - Event: **Push to a branch**
   - Repository: `second-order`
   - Branch: `^main$`
   - Configuration: **Cloud Build configuration file**, location **Repository**,
     path `cloudbuild.yaml`
   - Service account: `so-deployer`
   - **Create**
4. On the trigger list, click **Run** on `deploy-main` to do the first deploy
   now. It takes about 5 to 8 minutes. Click the build in **History** to
   watch it.

When it finishes, open `https://<your-project-id>.web.app`. You should see the
Second Order page with the commit shown.

## 7. Connect the database

The site works without this; trial data just can't be saved until it's done.

1. Sign up at neon.com (free plan). **Create project**:
   name `second-order`, region **AWS Asia Pacific (Sydney)**. The region can't
   be changed later.
2. On the project dashboard, **Connect** → copy the connection string. It
   starts with `postgresql://` and ends with `sslmode=require`.
3. Back in Google Cloud: **Security → Secret Manager → Create secret**.
   Name: `DATABASE_URL` (exactly). Secret value: paste the string. **Create**.
4. Open the new secret → **Permissions** → **Grant access**.
   Principal: `<project-number>-compute@developer.gserviceaccount.com`
   (the project number is on the Google Cloud home page, next to the Project ID).
   Role: **Secret Manager Secret Accessor**. **Save**.
5. Cloud Build → Triggers → **Run** on `deploy-main` again.

Check: `https://<your-project-id>.web.app/api/ingest/health` should show
`"db": "ok"`, and the demo page at `/run/demo/` should say `"accepted": 1`.

## 8. Point 2ndorder.live at it

1. Firebase console → **Hosting → Add custom domain** → `2ndorder.live`.
2. Firebase shows DNS records (a TXT record to prove ownership, then A records).
   Add them in your domain registrar's DNS settings, exactly as shown.
3. Wait. Verification is often minutes; the HTTPS certificate can take up to
   24 hours. Firebase shows the status.
4. Optional: add `www.2ndorder.live` too and set it to redirect to
   `2ndorder.live`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Trigger won't save: service account error | Logging option | Already handled in `cloudbuild.yaml` (`CLOUD_LOGGING_ONLY`); check you picked `so-deployer` |
| Build fails at `deploy-hosting` with a permission error | Firebase role too narrow | Swap **Firebase Hosting Admin** for **Firebase Admin** on `so-deployer` |
| Build fails at `deploy-hosting`: no site or project | Hosting not started | Do step 4.2, then **Run** the trigger again |
| Build fails at a `deploy-` step: `iam.serviceaccounts.actAs` | Missing role | Add **Service Account User** to `so-deployer` |
| Site shows "Page not found" from Firebase | Hosting deployed before Cloud Run existed | **Run** the trigger again |
| `/api/ingest/health` shows `"db": "unreachable"` | Secret value or access | Re-check step 7 (secret name, value, and the permission on it) |
| `"db": "not configured"` after step 7 | Deployed before the secret existed | **Run** the trigger again |

Every build's log is in **Cloud Build → History**. On GitHub, the tick or cross
next to a commit links to it.

## What this costs

At lab scale, everything should sit inside free tiers: Cloud Build includes
2,500 build-minutes a month, Cloud Run and Firebase Hosting have monthly free
allowances, and Neon's free plan covers a database this size. The one thing
that slowly grows is stored container images; in **Artifact Registry**, add a
cleanup policy to keep the 10 most recent versions of each image.
