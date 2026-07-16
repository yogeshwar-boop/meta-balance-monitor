// check-balance.js
// Reads "Available funds" balance for one or more Meta Ads accounts by loading
// the Ads Manager billing page with an authenticated session (cookies), and
// sends a Slack + email alert if the balance is below THRESHOLD.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const THRESHOLD = parseFloat(process.env.THRESHOLD || '10000');

const ACCOUNTS = [process.env.AD_ACCOUNT_1, process.env.AD_ACCOUNT_2]
  .filter(Boolean)
  .map((id) => id.replace(/^act_/, ''));

// ---------- Cookie handling ----------
function mapSameSite(value) {
  if (!value) return 'Lax';
  const v = String(value).toLowerCase();
  if (v.includes('no_restriction') || v === 'none') return 'None';
  if (v.includes('strict')) return 'Strict';
  return 'Lax';
}

function toPlaywrightCookies(rawCookies) {
  return rawCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith('.') ? c.domain : `.${c.domain.replace(/^www\./, '')}`,
    path: c.path || '/',
    expires: c.expirationDate ? Math.floor(c.expirationDate) : Math.floor(Date.now() / 1000) + 3600 * 24 * 30,
    httpOnly: !!c.httpOnly,
    secure: c.secure !== undefined ? !!c.secure : true,
    sameSite: mapSameSite(c.sameSite),
  }));
}

// ---------- Balance extraction ----------
function extractBalance(fullText) {
  const idx = fullText.indexOf('Available funds');
  if (idx === -1) return { found: false };
  const snippet = fullText.slice(idx, idx + 300);
  const match = snippet.match(/₹\s?([\d,]+\.\d{1,2})/);
  if (!match) return { found: false };
  const value = parseFloat(match[1].replace(/,/g, ''));
  return { found: true, value };
}

function looksLoggedOut(fullText) {
  return (
    fullText.includes('Log into Facebook') ||
    fullText.includes('You must log in to continue') ||
    fullText.includes('Log into business tools from Meta') ||
    (fullText.includes('Get started with') && fullText.includes('business tools from Meta')) ||
    (fullText.includes('Log In') && fullText.includes('Forgotten password'))
  );
}

// ---------- Alerts ----------
async function sendSlack(message) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
}

async function sendEmail(subject, text) {
  const { EMAIL_USER, EMAIL_PASS, EMAIL_TO } = process.env;
  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  await transporter.sendMail({
    from: EMAIL_USER,
    to: EMAIL_TO,
    subject,
    text,
  });
}

// ---------- Main ----------
async function checkAccount(browser, accountId) {
  const context = await browser.newContext();

  let rawCookies;
  try {
    rawCookies = JSON.parse(process.env.FB_COOKIES);
  } catch (e) {
    throw new Error('FB_COOKIES secret is not valid JSON. Re-export cookies and update the secret.');
  }

  // Safe diagnostic: names + domains only, never values.
  const importantNames = ['c_user', 'xs', 'datr', 'sb', 'fr'];
  const foundNames = rawCookies.map((c) => c.name);
  const domains = [...new Set(rawCookies.map((c) => c.domain))];
  console.log(`[DEBUG] Loaded ${rawCookies.length} cookies from FB_COOKIES.`);
  console.log(`[DEBUG] Domains present: ${domains.join(', ')}`);
  console.log(`[DEBUG] Key auth cookies present: ${importantNames.filter((n) => foundNames.includes(n)).join(', ') || 'NONE FOUND'}`);

  await context.addCookies(toPlaywrightCookies(rawCookies));

  const page = await context.newPage();
  const url = `https://adsmanager.facebook.com/ads/manager/account_settings/account_billing/?act=${accountId}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000); // let client-side content render

  const fullText = await page.innerText('body');

  if (looksLoggedOut(fullText)) {
    await context.close();
    return { accountId, error: 'session_expired' };
  }

  const result = extractBalance(fullText);

  if (!result.found) {
    // Diagnostic output: show what we actually saw so the extraction logic can be fixed.
    // Strip the account ID first so GitHub's secret-masking doesn't blank the whole dump.
    const safeText = fullText.split(accountId).join('[ACCT]');
    const idx = safeText.indexOf('Available funds');
    if (idx === -1) {
      console.log(`[DEBUG] "Available funds" text not found on page at all. First 1500 chars of body text:`);
      console.log(safeText.slice(0, 1500));
    } else {
      console.log(`[DEBUG] "Available funds" found, but no currency amount matched nearby. Surrounding text:`);
      console.log(safeText.slice(Math.max(0, idx - 50), idx + 400));
    }
    await context.close();
    return { accountId, error: 'balance_not_found' };
  }

  await context.close();
  return { accountId, balance: result.value };
}

(async () => {
  if (ACCOUNTS.length === 0) {
    console.error('No ad account IDs configured (AD_ACCOUNT_1 / AD_ACCOUNT_2).');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const results = [];

  for (const accountId of ACCOUNTS) {
    try {
      const r = await checkAccount(browser, accountId);
      results.push(r);
    } catch (e) {
      results.push({ accountId, error: e.message });
    }
  }

  await browser.close();

  console.log('Check results:', JSON.stringify(results, null, 2));

  const lowBalanceAccounts = results.filter((r) => r.balance !== undefined && r.balance < THRESHOLD);
  const errorAccounts = results.filter((r) => r.error);

  if (lowBalanceAccounts.length > 0) {
    const lines = lowBalanceAccounts
      .map((r) => `• act_${r.accountId}: ₹${r.balance.toLocaleString('en-IN')} (below ₹${THRESHOLD.toLocaleString('en-IN')} threshold)`)
      .join('\n');
    const message = `⚠️ Meta Ads balance alert:\n${lines}`;
    await sendSlack(message);
    await sendEmail('Meta Ads: Low prepaid balance alert', message);
  }

  if (errorAccounts.length > 0) {
    const lines = errorAccounts
      .map((r) => `• act_${r.accountId}: ${r.error}`)
      .join('\n');
    const message = `🔧 Meta Ads balance check had errors (script needs attention):\n${lines}\n\nIf error is "session_expired", re-export your Facebook cookies and update the FB_COOKIES secret in GitHub.`;
    await sendSlack(message);
    await sendEmail('Meta Ads balance monitor: check failed', message);
  }

  if (lowBalanceAccounts.length === 0 && errorAccounts.length === 0) {
    console.log('All accounts above threshold. No alert sent.');
  }
})();
