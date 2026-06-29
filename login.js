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
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
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

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => console.warn('domcontentloaded 超时，继续'));

  await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: 30000, state: 'attached' }).catch(() => {});

  const pageInfo = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
      id: el.id, name: el.name, type: el.type, placeholder: el.placeholder,
      className: el.className?.slice(0, 60), autocomplete: el.autocomplete,
      visible: el.offsetParent !== null,
    }));
    const buttons = Array.from(document.querySelectorAll('button, .btn, [role="button"], a.btns')).map(el => ({
      id: el.id, text: el.textContent?.trim()?.slice(0, 40), className: el.className?.slice(0, 60),
    }));
    const bodyText = document.body?.innerText?.slice(0, 500);
    return { inputs, buttons, bodyText };
  });

  console.log('输入框:', JSON.stringify(pageInfo.inputs, null, 2));
  console.log('按钮:', JSON.stringify(pageInfo.buttons, null, 2));

  if (pageInfo.inputs.length === 0) {
    console.log('未发现输入框，尝试点击登录切换按钮...');
    const tabTexts = ['百度账号', '密码登录', '账号密码', '登录'];
    for (const text of tabTexts) {
      const clicked = await page.evaluate((t) => {
        const el = [...document.querySelectorAll('div, span, a, button, li, label')].find(e =>
          e.textContent?.trim() === t && e.offsetParent !== null
        );
        if (el) { el.click(); return true; }
        return false;
      }, text);
      if (clicked) {
        console.log('已点击:', text);
        await page.waitForTimeout(2000);
        break;
      }
    }
    const retry = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        id: el.id, name: el.name, type: el.type, placeholder: el.placeholder,
      }))
    );
    console.log('点击后输入框:', JSON.stringify(retry, null, 2));
    if (retry.length === 0) {
      console.error('仍未找到输入框，页面文字:', pageInfo.bodyText);
      process.exit(1);
    }
    pageInfo.inputs = retry; pageInfo.buttons = [];
  }

  const userCandidates = pageInfo.inputs.filter(i => i.type === 'text' && i.visible);
  const passCandidates = pageInfo.inputs.filter(i => i.type === 'password' && i.visible);

  if (userCandidates.length === 0 || passCandidates.length === 0) {
    const allTextInputs = pageInfo.inputs.filter(i => i.type === 'text');
    const allPassInputs = pageInfo.inputs.filter(i => i.type === 'password');
    if (allTextInputs.length > 0 && allPassInputs.length > 0) {
      const tabBtn = pageInfo.buttons.find(b =>
        /密码|账号|登录/.test(b.text) && !/注册/.test(b.text)
      );
      if (tabBtn && tabBtn.id) {
        await page.click('#' + tabBtn.id);
        await page.waitForTimeout(1000);
      }
    }
    const checkAgain = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => ({
        id: el.id, type: el.type, visible: el.offsetParent !== null,
      }))
    );
    console.log('点击切换后输入框:', JSON.stringify(checkAgain, null, 2));
  }

  const visibleUser = (await page.evaluate(() => {
    const el = document.querySelector('input[type="text"]');
    return el && el.offsetParent !== null ? el.id || el.name || el.placeholder : null;
  }));
  const visiblePass = (await page.evaluate(() => {
    const el = document.querySelector('input[type="password"]');
    return el && el.offsetParent !== null ? el.id || el.name || el.placeholder : null;
  }));

  if (!visibleUser || !visiblePass) {
    console.error('没有可见的用户名/密码输入框');
    process.exit(1);
  }

  await page.locator('input[type="text"]').first().fill(creds.username, { force: true });
  await page.locator('input[type="password"]').first().fill(creds.password, { force: true });

  const cb = page.locator('input[type="checkbox"]').first();
  if (await cb.isVisible().catch(() => false)) {
    if (!(await cb.isChecked())) {
      await cb.check({ force: true });
    }
  }

  const submitBtn = pageInfo.buttons.find(b =>
    /登录|submit|提交/.test(b.text)
  ) || pageInfo.buttons.find(b => /登录|submit/.test(b.text?.toLowerCase()));

  if (submitBtn) {
    await page.locator(`#${submitBtn.id}`).click({ force: true });
    console.log('已点击登录按钮:', submitBtn.text);
  } else {
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    });
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
