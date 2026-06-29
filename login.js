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
    process.exit(1);
  }

  // passport.baidu.com 比 BCE 登录页加载快得多
  const loginUrl = 'https://passport.baidu.com/v2/?login';
  const targetUrl = 'https://www.miaoda.cn/';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // 拦截 bce.bdstatic.com（超时源），其他资源（含真实 jQuery）正常加载
  await page.route('**/*', route => {
    if (route.request().url().includes('bce.bdstatic.com')) {
      route.abort('timedout');
    } else {
      route.continue();
    }
  });

  // —————— Cookie 验证 ——————
  const cached = loadCachedCookies();
  if (cached) {
    await context.addCookies(cached);
    console.log('发现缓存 Cookie，直接访问目标...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const afterUrl = page.url();
    if (!afterUrl.includes('login') && !afterUrl.includes('passport')) {
      console.log('Cookie 有效');
      saveCookies(cached);
      await browser.close();
      return;
    }
    console.log('Cookie 已过期，重新登录');
  }

  // —————— 登录 ——————
  console.log('前往登录页...');
  await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => {});

  // 等待表单出现（passport 页面通常 <10 秒）
  console.log('等待页面加载...');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const hasForm = await page.evaluate(() =>
      !!document.getElementById('TANGRAM__PSP_3__userName')
    ).catch(() => false);
    if (hasForm) { ready = true; break; }
    if (i % 5 === 0) console.log(`等待表单... i=${i + 1}/30`);
    await page.waitForTimeout(2000);
  }
  if (!ready) {
    console.error('表单未加载');
    process.exit(1);
  }
  console.log('表单已就绪，切换至账号登录...');

  // 先点击"账号登录" tab
  await page.evaluate(() => {
    const tab = document.querySelector('#TANGRAM__PSP_3__accountTab, a[data-tab="account"], .pass-tab-account');
    if (tab) tab.click();
    // 另一种方式：直接触发 TANGRAM 的切换
    const switchLink = document.querySelector('a:has-text("账号登录"), span:has-text("账号登录")');
    if (switchLink && switchLink.closest) switchLink.click();
  });
  await page.waitForTimeout(1500);

  // 填写表单（优先 Playwright 原生，不可见时回退到 evaluate）
  console.log('填写表单...');
  const userNameEl = page.locator('#TANGRAM__PSP_3__userName');
  if (await userNameEl.isVisible().catch(() => false)) {
    await userNameEl.fill(creds.username);
  } else {
    await page.evaluate((u) => {
      const el = document.getElementById('TANGRAM__PSP_3__userName');
      if (el) { el.value = u; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, creds.username);
  }
  const passEl = page.locator('#TANGRAM__PSP_3__password');
  if (await passEl.isVisible().catch(() => false)) {
    await passEl.fill(creds.password);
  } else {
    await page.evaluate((p) => {
      const el = document.getElementById('TANGRAM__PSP_3__password');
      if (el) { el.value = p; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, creds.password);
  }
  // 勾选"记住我"
  await page.evaluate(() => {
    const cb = document.getElementById('TANGRAM__PSP_3__memberPass');
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  console.log('表单已填写');

  await page.waitForTimeout(500);

  // Playwright 原生点击（先尝试点击，失败则 evaluate + Enter）
  console.log('提交登录...');
  const submitBtn = page.locator('#TANGRAM__PSP_3__submit');
  try {
    await submitBtn.waitFor({ state: 'visible', timeout: 3000 });
    await submitBtn.click({ timeout: 10000 });
  } catch {
    await page.evaluate(() => {
      const btn = document.getElementById('TANGRAM__PSP_3__submit');
      if (btn) btn.click();
    });
    await page.keyboard.press('Enter');
  }

  // 等待登录完成——检测 URL 离开 passport/login
  console.log('等待登录完成...');
  let loginDone = false;
  let finalUrl = '';
  for (let i = 0; i < 60; i++) {
    finalUrl = page.url();
    if (!finalUrl.includes('passport.baidu.com') && !finalUrl.includes('/login')) {
      loginDone = true;
      break;
    }
    // 检查是否有错误提示
    const errMsg = await page.evaluate(() => {
      const el = document.querySelector('.pass-error, .errmsg, .error-tip, [class*="error"]');
      return el?.textContent?.trim() || '';
    }).catch(() => '');
    if (errMsg && i % 5 === 0) console.log('当前错误:', errMsg);
    await page.waitForTimeout(2000);
  }

  if (!loginDone) {
    const content = await page.evaluate(() => document.body?.innerText?.slice(0, 800)).catch(() => 'N/A');
    console.error('登录失败，页面内容:', content);
    process.exit(1);
  }

  console.log('登录成功，当前 URL:', finalUrl);
  const cookies = await context.cookies();
  saveCookies(cookies);
  await browser.close();
})();
