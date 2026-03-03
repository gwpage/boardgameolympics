# Cloudflare Setup Guide

This guide walks you through signing up for Cloudflare and configuring Cloudflare Pages to host the Board Game Olympics static site.

---

## Step 1: Create a Cloudflare Account

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. Sign up with your email and a password. No credit card required.
3. Verify your email address.

---

## Step 2: Connect Your Custom Domain

Since you already have a domain reserved, you'll need to add it to Cloudflare so it can manage DNS.

1. From the Cloudflare dashboard, click **"Add a site"**.
2. Enter your domain name and select the **Free plan**.
3. Cloudflare will scan your existing DNS records. Review them and confirm.
4. Cloudflare will give you two **nameservers** (e.g., `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`).
5. Go to your domain registrar (wherever you purchased the domain) and **update the nameservers** to the ones Cloudflare provided.
6. Wait for DNS propagation (can take a few minutes to 24 hours, usually under an hour).
7. Once active, Cloudflare will manage DNS and automatically provision a free SSL certificate for your domain.

---

## Step 3: Create a Cloudflare Pages Project

There are two ways to deploy: via a Git repository (recommended) or via direct upload.

### Option A: Deploy from a Git Repository (Recommended)

1. In the Cloudflare dashboard, go to **Workers & Pages** in the left sidebar.
2. Click **"Create"** → **"Pages"** → **"Connect to Git"**.
3. Authorize Cloudflare to access your GitHub (or GitLab) account.
4. Select the repository containing your Board Game Olympics code.
5. Configure the build settings:
   - **Production branch**: `main`
   - **Build command**: Leave blank (no build step — it's plain HTML/CSS/JS).
   - **Build output directory**: `/` (or whichever folder contains your `index.html`).
6. Click **"Save and Deploy"**.

Every push to `main` will automatically redeploy the site. Pushes to other branches will create preview deployments at unique URLs.

### Option B: Direct Upload

1. Go to **Workers & Pages** → **"Create"** → **"Pages"** → **"Upload assets"**.
2. Drag and drop your project folder or select files.
3. Click **"Deploy"**.

This is fine for one-off deploys but doesn't give you automatic CI/CD.

---

## Step 4: Assign Your Custom Domain to the Pages Project

1. Go to **Workers & Pages** → select your project.
2. Click the **"Custom domains"** tab.
3. Click **"Set up a custom domain"**.
4. Enter your domain (e.g., `boardgameolympics.com` or `www.boardgameolympics.com`).
5. Cloudflare will automatically create the required DNS record since it already manages your domain.
6. SSL is provisioned automatically — no configuration needed.

---

## Useful Links

- [Cloudflare Pages documentation](https://developers.cloudflare.com/pages/)
- [Pages free tier limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Pages pricing](https://www.cloudflare.com/plans/developer-platform/)
