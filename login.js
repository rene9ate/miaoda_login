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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
    ],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const cached = loadCachedCookies();
  if (cached) {
    await context.addCookies(cached);
    console.log('发现缓存 Cookie，尝试直接访问目标页面');
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    try {
      await page.waitForURL(targetPattern, { timeout: 15000 });
      console.log('Cookie 有效，登录成功!');
      const cookies = await context.cookies();
      saveCookies(cookies);
      await browser.close();
      return;
    } catch {
      console.log('Cookie 已过期，重新登录');
    }
  }

  await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 });

  await page.waitForSelector('input[type="text"], input[type="email"], input[name="userName"], input[autocomplete="username"]', { timeout: 20000 });

  const inputs = await page.evaluate(() => {
    const all = document.querySelectorAll('input');
    return Array.from(all).map(el => ({
      id: el.id,
      name: el.name,
      type: el.type,
      placeholder: el.placeholder,
      className: el.className?.slice(0, 60),
      autocomplete: el.autocomplete,
    }));
  });
  console.log('页面 input 元素:', JSON.stringify(inputs, null, 2));

  if (inputs.length === 0) {
    console.error('页面上没有找到 input 元素');
    console.error('页面文字:', await page.evaluate(() => document.body?.innerText?.slice(0, 800)).catch(() => 'N/A'));
    process.exit(1);
  }

  const userInput = inputs.find(i => i.type === 'text' || i.autocomplete === 'username' || i.name?.toLowerCase().includes('user') || i.placeholder?.toLowerCase().includes('账号') || i.placeholder?.toLowerCase().includes('手机'));
  const passInput = inputs.find(i => i.type === 'password');
  const agreeInput = await page.locator('input[type="checkbox"]').first().isVisible().then(() => true).catch(() => false);

  if (!userInput || !passInput) {
    console.error('未找到用户名或密码输入框');
    process.exit(1);
  }

  console.log('填入账号...');
  await page.fill('#' + userInput.id, creds.username);
  console.log('填入密码...');
  await page.fill('#' + passInput.id, creds.password);

  if (agreeInput) {
    const cb = page.locator('input[type="checkbox"]').first();
    if (!(await cb.isChecked())) {
      await cb.check();
      console.log('已勾选同意');
    }
  }

  const submitBtn = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"], .submit-btn, button:has(span)');
    if (btn) {
      btn.click();
      return 'ok';
    }
    return 'not found';
  });

  if (submitBtn === 'not found') {
    console.error('未找到登录按钮');
    process.exit(1);
  }

  console.log('已点击登录，等待跳转...');

  try {
    await page.waitForURL(targetPattern, { timeout: 15000 });
    console.log('登录成功!');
    const cookies = await context.cookies();
    saveCookies(cookies);
  } catch (error) {
    const errorMsg = await page.locator('.error-message, .errmsg, [class*="error"]').textContent().catch(() => null);
    if (errorMsg) {
      console.error('登录失败:', errorMsg.trim());
    } else {
      console.error('登录超时或跳转失败');
    }
    process.exit(1);
  }

  await browser.close();
})();
