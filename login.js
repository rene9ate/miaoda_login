const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache', 'cookies.json');
const BCE_LOGIN_URL =
  'https://login.bce.baidu.com/?redirect=https%3A%2F%2Fconsole.bce.baidu.com%2Fapi%2Fiam%2Foauth2%2Fconnect%3Fclient_id%3Ddb7e162f32a6484a8b0db889b6f37836%26response_type%3Dcode%26redirect_uri%3Dhttps%253A%252F%252Fwww.miaoda.cn%252Foauth2%252Fcallback%252Fiam%253Fredirect_uri%253D%25252F%25253FautoLogin%25253Dfalse%26scope%3Duser_info%26state%3Dfda681e1-ca94-4f11-a0db-48bcd52f2e0f%26from%3Doa_db7e162f32a6484a8b0db889b6f37836%26iam_state%3Dauth&from=oa_db7e162f32a6484a8b0db889b6f37836';

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

let browser = null;

async function cleanup() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(143); });

(async () => {
  try {
    const isDebug = process.argv.includes('--debug') || process.argv.includes('-D');
    const keyArg = process.argv.find(a => !a.startsWith('-') && a.includes(':'));
    const key = process.env.LOGIN_KEY || keyArg;
    if (!key) throw new Error('请设置 LOGIN_KEY 环境变量');
    const creds = parseKey(key);
    if (!creds) throw new Error('LOGIN_KEY 格式: user:pass');

    browser = await chromium.launch({
      headless: !isDebug,
      slowMo: isDebug ? 500 : 0,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // 反检测：隐藏 webdriver 特征
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    });

    // —————— Cookie 缓存验证 ——————
    const cached = loadCachedCookies();
    if (cached) {
      await context.addCookies(cached);
      console.log('使用缓存 Cookie，访问 miaoda.cn...');
      await page.goto('https://www.miaoda.cn/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
      console.log('页面文字:', pageText.replace(/\n/g, ' '));
      if (/退出|注销|我的|个人中心|账户|额度|余额/i.test(pageText)) {
        console.log('Cookie 有效，已登录');
        return;
      }
      console.log('Cookie 已过期，重新登录');
    }

    // —————— 先访问百度首页建立会话 ——————
    console.log('访问百度首页建立会话...');
    await page.goto('https://www.baidu.com/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    console.log('百度首页已加载');

    // —————— 前往 BCE 登录页 ——————
    console.log('前往 BCE 登录页...');
    await page.goto(BCE_LOGIN_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    console.log('当前页面:', page.url().slice(0, 120));

    // 等待表单加载（灵活选择器，适配 TANGRAM/CAS 不同版本）
    console.log('等待登录表单...');
    const USER_SELECTORS = [
      '#TANGRAM__PSP_4__userName',
      '#TANGRAM__PSP_3__userName',
      '#TANGRAM__PSP_4__email',
      '#userName',
      '#account',
      '#TANGRAM__PSP_4__phone',
    ];
    let formReady = false;
    let userNameSelector = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
      for (const sel of USER_SELECTORS) {
        const el = await page.$(sel);
        if (el) { formReady = true; userNameSelector = sel; break; }
      }
      if (formReady) break;
      if (attempt < 3) {
        const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 200)).catch(() => '');
        console.log(`表单未就绪 [${attempt}/3]: "${text.replace(/\n/g, ' ')}"`);
        await page.goto(BCE_LOGIN_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      }
    }
    if (!formReady) {
      const html = await page.evaluate(() => document.documentElement?.outerHTML?.slice(0, 2000) || '').catch(() => '');
      console.log('页面 HTML:', html.slice(0, 500));
      throw new Error('登录表单未加载');
    }
    console.log('表单就绪, 选择器:', userNameSelector);

    // 推导密码和提交按钮选择器
    const pwdPrefix = userNameSelector.replace('userName', '').replace('email', '').replace('phone', '').replace('account', '').replace('#', '');
    const pwdSelector = pwdPrefix ? `#${pwdPrefix}password` : '#password';
    const submitSelector = pwdPrefix ? `#${pwdPrefix}submit` : '#submit';
    const agreeSelector = pwdPrefix ? `#${pwdPrefix}isAgree` : '#isAgree';

    // 填入用户名密码 — 先 evaluate 设置隐藏字段的值 + 触发事件
    await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: userNameSelector, val: creds.username });
    console.log('用户名已填写');

    await page.evaluate(({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: pwdSelector, val: creds.password });
    console.log('密码已填写');

    // 勾选协议
    const agreeEl = await page.$(agreeSelector);
    if (agreeEl) {
      await page.evaluate((sel) => {
        const cb = document.querySelector(sel);
        if (cb) cb.checked = true;
      }, agreeSelector);
      console.log('协议已勾选');
    }

    // 提交登录 — 多策略
    console.log('提交登录...');
    let submitted = false;

    // 策略 1：使提交按钮可见后用 click
    const submitMadeVisible = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return false;
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true; // 已可见
      btn.style.display = 'block';
      btn.style.width = '200px';
      btn.style.height = '50px';
      btn.style.opacity = '1';
      btn.style.position = 'fixed';
      btn.style.top = '400px';
      btn.style.left = '500px';
      btn.style.zIndex = '9999';
      return true;
    }, submitSelector);

    if (submitMadeVisible) {
      try {
        await page.click(submitSelector, { timeout: 5000 });
        submitted = true;
        console.log('策略 1: click 提交');
      } catch (e) {
        console.log('策略 1 click 失败:', e.message.slice(0, 60));
      }
    }

    // 策略 2：requestSubmit 触发原生提交事件
    if (!submitted) {
      try {
        await page.evaluate((sel) => {
          const form = document.querySelector(sel)?.closest('form');
          if (!form) throw new Error('form not found');
          form.requestSubmit();
        }, userNameSelector);
        submitted = true;
        console.log('策略 2: requestSubmit');
      } catch (e) {
        console.log('策略 2 requestSubmit 失败:', e.message.slice(0, 60));
      }
    }

    // 策略 3：直接 form.submit()
    if (!submitted) {
      await page.evaluate((sel) => {
        const form = document.querySelector(sel)?.closest('form');
        if (form) form.submit();
      }, userNameSelector);
      console.log('策略 3: form.submit');
    }

    // 等待跳转（OAuth 回调或 miaoda.cn）
    console.log('等待 OAuth 跳转...');
    try {
      await page.waitForURL(url => url.includes('miaoda.cn'), { timeout: 30000 });
      console.log('跳转成功:', page.url().slice(0, 100));
    } catch {
      console.log('当前页面:', page.url().slice(0, 120));
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // 验证登录
    const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
    console.log('页面文字:', pageText.replace(/\n/g, ' '));
    const loggedIn = /退出|注销|个人中心|账户|额度|余额|我的/i.test(pageText);

    if (!loggedIn) {
      throw new Error('登录验证失败');
    }
    console.log('登录成功');

    const cookies = await context.cookies();
    saveCookies(cookies);
    if (process.env.GITHUB_OUTPUT) {
      require('fs').appendFileSync(process.env.GITHUB_OUTPUT, 'cookies_changed=true\n');
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
