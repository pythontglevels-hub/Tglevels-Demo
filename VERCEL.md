# Putting Strategy Lab on Vercel (with a tglevels.com subdomain)

The project is ready for Vercel as it is. `vercel.json` and `api/index.js`
run the Node server as one serverless function and serve `public/` (the
page and TradingView's library) as static files.

## What works differently on Vercel

| Area | On Vercel |
|---|---|
| Page, chart, playback, practice trading | Same as before. |
| Live mode | Vercel ends any request after 5 minutes. The server closes the live stream at 4½ minutes and the page reconnects by itself and carries on from the same candle. Open trades are kept. Viewers may see "Reconnecting…" for a second. |
| Adding historical data | The server can't write files on Vercel. Run `npm run add-data` **on your computer**, then push (or redeploy). Each deploy swaps in all at once, so there's no downtime. |
| Big datasets | Vercel refuses responses over 4.5 MB. Responses are gzipped (30,000 candles come to about 0.9 MB), so files up to roughly 100,000 candles are fine. |
| Plan | Vercel's free Hobby plan is for personal, non-commercial use only. A company site needs the Pro plan. |

## 1. Put the code in a private GitHub repository

TradingView's licence doesn't allow the library to be public, so the
repository **must be private**.

1. Copy TradingView's `charting_library` folder to `public/charting_library/`.
2. Put your CSV files in `data/historical/` (or add them with `npm run add-data`, see below).
3. Push the whole folder to a new **private** GitHub repository:

```bash
cd strategy-demo
git init
git add .
git commit -m "Strategy Lab"
git branch -M main
git remote add origin https://github.com/YOUR-ORG/strategy-lab.git   # private repo
git push -u origin main
```

Check that GitHub shows `public/charting_library/` and the `.csv` files in
`data/historical/`. `.gitignore` only leaves out `node_modules`.

## 2. Create the Vercel project

1. Sign in at https://vercel.com and choose **Add New… → Project**.
2. Import the GitHub repository. (Allow Vercel access to private repos when asked.)
3. Leave **Framework Preset** as **Other**. Leave Build Command, Output
   Directory and Install Command alone, because `vercel.json` sets them.
4. Click **Deploy**. After about a minute you get a URL like
   `strategy-lab-xxxx.vercel.app`. Open it and check the chart loads and the
   Dataset list shows your files.

No environment variables are needed.

## 3. Point demo.tglevels.com at it

1. In the Vercel project, open **Settings → Domains**, type
   `demo.tglevels.com` (or your choice) and click **Add**.
2. Vercel shows a DNS record to create, normally:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `demo` | the value Vercel shows (e.g. `cname.vercel-dns.com` or a project-specific `….vercel-dns-0xx.com`) |

3. Add that record wherever tglevels.com's DNS is managed (GoDaddy,
   Hostinger, Cloudflare…). Use exactly the value Vercel shows. If the DNS
   is on Cloudflare, set the record to **DNS only** (grey cloud).
4. Back in Vercel the domain turns to **Valid Configuration** within a few
   minutes, and Vercel issues the HTTPS certificate itself.

This only adds a subdomain. The main tglevels.com site and email aren't
touched.

## Adding or updating historical data

On your computer, in the project folder:

```bash
npm install                                   # once
npm run add-data -- ~/Downloads/NIFTY_15min.xlsx
git add data/historical && git commit -m "Add NIFTY 15min" && git push
```

Vercel redeploys on every push (about a minute) and switches over in one
step, so the site never goes down. `--replace`, `--remove NAME` and
`--list` work as described in the README. Remove a dataset the same way:
`npm run add-data -- --remove NAME`, then commit and push.

## Updating the code

Replace the files, commit and push. Vercel builds and switches over with
no downtime. To undo a bad deploy, open **Deployments**, pick the last good
one and choose **Promote to Production** (or **Instant Rollback**).

## Without GitHub (Vercel CLI)

```bash
npm i -g vercel
cd strategy-demo
vercel           # first time: log in and create the project
vercel --prod    # deploy to production
```

Then add the domain as in step 3. After adding data, run `vercel --prod`
again.

## If something's wrong

- **"library could not be loaded"**: `public/charting_library/` didn't
  make it into the deploy. Check it's in the repository.
- **Dataset list empty**: the CSVs aren't in `data/historical/` in the
  repository.
- **Errors in /api calls**: open the project in Vercel, then **Logs**, to
  see the server's error messages.
