# Meta Ads Balance Monitor

Checks the "Available funds" balance on your Meta Ads accounts every 6 hours
and sends a Slack + email alert if either drops below ₹10,000.

## How it works
- Runs on GitHub Actions (free, no server needed on your end)
- Loads Ads Manager billing page using a saved, logged-in browser session (cookies)
- Reads the "Available funds" number directly off the page
- Alerts you if it's below threshold, or if the session has expired

## Maintenance
Facebook session cookies expire periodically (weeks to a couple months,
varies). If you get a Slack/email alert saying `session_expired`:
1. Log into Facebook normally in Chrome
2. Open Cookie-Editor extension → Export as JSON
3. Go to repo Settings → Secrets and variables → Actions → `FB_COOKIES` → Update
4. Done — next scheduled run will pick it up

## Manually triggering a check
Go to the repo's **Actions** tab → "Check Meta Ads Balance" workflow →
**Run workflow** button.

## Changing the threshold or schedule
- Threshold: edit `THRESHOLD: '10000'` in `.github/workflows/check-balance.yml`
- Schedule: edit the `cron` line (currently every 6 hours, UTC time)
