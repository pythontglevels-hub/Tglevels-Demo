# Putting Strategy Lab on a tglevels.com subdomain

These steps use `demo.tglevels.com` as the example. Swap in whichever
subdomain you choose (`learn.`, `lab.` …). They assume a Linux server
(Ubuntu 22.04/24.04) you can SSH into. That can be the server that already
runs the dashboard or a small separate VPS (1 vCPU / 1–2 GB RAM is enough).

The finished setup:

```
visitor ──HTTPS──> nginx (demo.tglevels.com) ──> Node app (pm2, 2 processes, port 3000)
                                                    │
                       /var/lib/strategy-lab/historical/*.csv  <── npm run add-data
```

## 1. Point the subdomain at the server (DNS)

Wherever tglevels.com's DNS is managed (GoDaddy, Cloudflare, Hostinger,
etc.), add a record:

| Type | Name   | Value               | TTL  |
|------|--------|---------------------|------|
| A    | `demo` | your server's IPv4  | Auto |

This doesn't affect the main site or email. Check it after a few minutes:
`dig +short demo.tglevels.com` should print the server's IP. If you use
Cloudflare, leave the record **DNS only** (grey cloud) until HTTPS is set up
in step 5, then you can switch the proxy on.

## 2. Install Node, pm2 and nginx (once)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm install -g pm2
```

## 3. Put the code and the data folder in place

```bash
sudo mkdir -p /var/www/strategy-lab /var/lib/strategy-lab/historical /etc/strategy-lab
sudo chown -R $USER /var/www/strategy-lab /var/lib/strategy-lab

# from a git repo (recommended, makes updates one command):
git clone <your-repo-url> /var/www/strategy-lab
# or copy the folder up from your machine:
#   scp -r strategy-demo/* user@server:/var/www/strategy-lab/

cd /var/www/strategy-lab
npm ci --omit=dev
npm test
```

The historical data lives in `/var/lib/strategy-lab/historical`, outside the
code folder, so updating the code never touches it. To bring existing CSVs
over: `cp data/historical/*.csv /var/lib/strategy-lab/historical/`.

**The TradingView library.** Copy the `charting_library/` folder from
TradingView's private repository (see the README) into the code folder:

```bash
# from your machine, or git clone TradingView's repo on the server
scp -r charting_library user@server:/var/www/strategy-lab/public/
```

It's not part of this project's git repo, so `git pull` leaves it alone.
When TradingView releases a new version, copy the new folder over the old
one. Until it's in place the site loads but the chart area says the library
is missing.

## 4. Settings

```bash
sudo cp deploy/env.example /etc/strategy-lab/env
sudo chown root:$USER /etc/strategy-lab/env && sudo chmod 640 /etc/strategy-lab/env
```

The defaults are fine. Change `PORT` only if 3000 is taken (and in the
nginx file to match).

Start the app and make it come back after a reboot:

```bash
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints
curl -fsS http://127.0.0.1:3000/api/config > /dev/null && echo OK
```

## 5. nginx and HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/strategy-lab
sudo sed -i 's/demo.tglevels.com/YOUR-SUBDOMAIN.tglevels.com/' /etc/nginx/sites-available/strategy-lab
sudo ln -s /etc/nginx/sites-available/strategy-lab /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d demo.tglevels.com     # also sets up auto-renewal
```

Open `https://demo.tglevels.com`.

If this server already runs nginx for the dashboard, it's the same steps.
The new file only answers for the subdomain and leaves the other sites
alone.

## Adding historical data (no downtime)

There's no admin page. A developer adds data on the server:

```bash
# copy the file up from your machine
scp BAJFINANCE_15min.xlsx user@server:/tmp/

# on the server
cd /var/www/strategy-lab
npm run add-data -- /tmp/BAJFINANCE_15min.xlsx
```

It accepts Excel (`.xlsx`) or CSV. It checks the file first and prints the
candle count, timeframe, date range and any rows it had to fix; a bad file
is refused with the reason and nothing changes on the site. A good file goes
live immediately, with no restart. Visitors see it in the Dataset list the
next time they load the page.

| What | Command |
|------|---------|
| Add with a chosen name | `npm run add-data -- file.xlsx --name NIFTY_5m` |
| Use another sheet | `npm run add-data -- file.xlsx --sheet "15 min"` |
| Update an existing dataset | `npm run add-data -- file.xlsx --name NIFTY_5m --replace` |
| See what's on the site | `npm run add-data -- --list` |
| Take one off | `npm run add-data -- --remove NIFTY_5m` |

The new file is written next to the old one and swapped in one step, so a
visitor never loads a half-written file. Someone already playing back a
replaced dataset should reload. `--remove` moves the file to
`/var/lib/strategy-lab/historical/.deleted/`; move it back to undo.

The script reads the data folder from `/etc/strategy-lab/env`, so it writes
where the site reads.

## Already running the earlier version (with the admin page)?

Copy the new files over the old ones, then on the server:

```bash
cd /var/www/strategy-lab
rm -f server/admin.js server/admin.html test/admin.test.js
sudo sed -i '/^ADMIN_/d' /etc/strategy-lab/env      # the admin settings are no longer used
npm ci --omit=dev                                  # adds exceljs for Excel files
npm test
pm2 reload deploy/ecosystem.config.js --update-env
```

Then copy the new `deploy/nginx.conf` into place as in step 5 (it drops the
upload size limit and caches the TradingView library) and run
`sudo nginx -t && sudo systemctl reload nginx`. If certbot already added
HTTPS lines to your nginx file, edit the existing file instead of
overwriting it: delete the `client_max_body_size` line and the commented
`location /admin` block. Your datasets are untouched.

## Updating the code (no downtime)

```bash
cd /var/www/strategy-lab
bash deploy/update.sh
```

It pulls the latest code, installs dependencies, runs the tests, and reloads
the two app processes one at a time, so the site keeps answering
throughout. If you copy files up instead of using git, copy them and then
run `pm2 reload deploy/ecosystem.config.js --update-env`.

## Day-to-day

| What | Command |
|------|---------|
| Status / memory | `pm2 status` |
| Logs | `pm2 logs strategy-lab` |
| Change a setting | edit `/etc/strategy-lab/env`, then `pm2 reload deploy/ecosystem.config.js --update-env` |

## Notes

- The site doesn't connect to the dashboard database. Historical data only
  comes from the CSVs in the data folder.
- Live mode keeps one connection open per viewer. `MAX_LIVE_STREAMS`
  (default 50 per process) caps it.
- If the main tglevels.com is on shared hosting without Node.js support,
  the subdomain's A record can still point at a separate VPS. The main site
  isn't affected.
