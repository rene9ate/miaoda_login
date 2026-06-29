const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache', 'cookies.json');

function loadCachedCookies() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Cookie 缓存读取失败，将重新登录');
  }
  return null;
}

function saveCookies(cookies) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cookies, null, 2));
    console.log('Cookie 已缓存到', CACHE_FILE);
  } catch (e) {
    console.warn('Cookie 缓存写入失败:', e.message);
  }
}

function parseKey(key) {
  if (!key || !key.includes(':')) return null;
  const [username, ...rest] = key.split(':');
  const password = rest.join(':');
  if (!username || !password) return null;
  return { username, password };
}

(async () => {
  const key = process.env.LOGIN_KEY || process.argv[2];
  if (!key) {
    console.error('未提供登录凭据');
    process.exit(1);
  }
  const creds = parseKey(key);
  if (!creds) {
    console.error('用法: LOGIN_KEY=user:pass node login.js');
    console.error('或者:  node login.js "user:pass"');
    process.exit(1);
  }

  const loginUrl = 'https://login.bce.baidu.com/?redirect=https%3A%2F%2Fconsole.bce.baidu.com%2Fapi%2Fiam%2Foauth2%2Fconnect%3Fclient_id%3Ddb7e162f32a6484a8b0db889b6f37836%26response_type%3Dcode%26redirect_uri%3Dhttps%253A%252F%252Fwww.miaoda.cn%252Foauth2%252Fcallback%252Fiam%253Fredirect_uri%253D%25252F%25253Ftrack_id%25253Dpromolink-aj1ejsa8hn9c%26scope%3Duser_info%26state%3Dac3b67c9-d169-4cd9-be9c-fc0dbc08f926%26from%3Doa_db7e162f32a6484a8b0db889b6f37836%26iam_state%3Dauth&from=oa_db7e162f32a6484a8b0db889b6f37836';
  const targetPattern = '**/console.bce.baidu.com/**';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const cached = loadCachedCookies();
  if (cached) {
    await context.addCookies(cached);
    console.log('发现缓存 Cookie，尝试直接访问');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    try {
      await page.waitForURL(targetPattern, { timeout: 15000 });
      console.log('Cookie 有效，登录成功');
      const cookies = await context.cookies();
      saveCookies(cookies);
      await browser.close();
      return;
    } catch {
      console.log('Cookie 已过期，重新登录');
    }
  }

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => console.warn('domcontentloaded 超时，继续'));

  await page.waitForSelector('#uc-common-account', { timeout: 30000, state: 'attached' }).catch(() => {});

  const hasForm = await page.evaluate(() => !!document.getElementById('uc-common-account'));
  if (!hasForm) {
    console.error('未找到登录表单');
    process.exit(1);
  }

  await page.evaluate(({ username, password }) => {
    const userEl = document.getElementById('uc-common-account');
    const passEl = document.getElementById('ucsl-password-edit') || document.getElementById('uc-common-password');
    if (userEl) {
      userEl.value = username;
      userEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (passEl) {
      passEl.value = password;
      passEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, creds);

  await page.evaluate(() => {
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });

  const submitted = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') ||
                document.querySelector('#ucsl-submit') ||
                document.querySelector('.submit-btn') ||
                document.querySelector('[class*="submit"]') ||
                document.querySelector('[class*="login"]');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!submitted) {
    console.error('未找到登录按钮');
    process.exit(1);
  }

  console.log('已提交登录，等待跳转...');

  try {
    await page.waitForURL(targetPattern, { timeout: 20000 });
    console.log('登录成功');
    const cookies = await context.cookies();
    saveCookies(cookies);
  } catch {
    const errText = await page.evaluate(() => {
      const err = document.querySelector('.error-message, .errmsg, [class*="error"], .tip');
      return err?.textContent?.trim() || document.querySelector('.captcha') ? '需要验证码' : null;
    }).catch(() => null);
    if (errText) {
      console.error('登录失败:', errText);
    } else {
      console.error('登录超时或跳转失败');
    }
    process.exit(1);
  }

  await browser.close();
})();
