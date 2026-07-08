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
    const key = process.env.LOGIN_KEY || process.argv[2];
    if (!key) throw new Error('请设置 LOGIN_KEY 环境变量');
    const creds = parseKey(key);
    if (!creds) throw new Error('LOGIN_KEY 格式: user:pass');

    browser = await chromium.launch({
      headless: true,
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

    // —————— Cookie 缓存验证 ——————
    const cached = loadCachedCookies();
    if (cached) {
      await context.addCookies(cached);
      console.log('使用缓存 Cookie，访问 miaoda.cn...');
      await page.goto('https://www.miaoda.cn/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      console.log('当前页面:', page.url().slice(0, 80));

      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
      console.log('页面文字:', pageText.replace(/\n/g, ' '));
      const loggedIn = /退出|注销|我的|个人中心|账户|额度|余额/i.test(pageText);

      if (loggedIn) {
        console.log('Cookie 有效，已登录');
        return;
      }
      console.log('Cookie 已过期，重新登录');
    }

    // —————— BCE 登录 ——————
    console.log('前往 BCE 登录页...');
    await page.goto(BCE_LOGIN_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    console.log('当前页面:', page.url().slice(0, 80));

    // 等待表单（BCE 页面 TANGRAM 可能加载慢，重试 3 次）
    console.log('等待登录表单...');
    let formReady = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      const hasForm = await page.$('#TANGRAM__PSP_4__userName');
      if (hasForm) { formReady = true; break; }
      if (attempt < 3) {
        console.log(`表单未就绪 (尝试 ${attempt}/3)，重新加载...`);
        await page.goto(BCE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    }
    if (!formReady) {
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
      console.log('页面内容:', bodyText.replace(/\n/g, ' '));
      throw new Error('登录表单未加载（BCE CDN 可能不可达）');
    }
    console.log('表单就绪');

    // 填入用户名密码 + 勾选协议
    await page.evaluate(({ username, password }) => {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal('TANGRAM__PSP_4__userName', username);
      setVal('TANGRAM__PSP_4__password', password);
      const cb = document.getElementById('TANGRAM__PSP_4__isAgree');
      if (cb) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, { username: creds.username, password: creds.password });

    // 找到 TANGRAM 的可见提交按钮并点击
    console.log('提交登录...');
    const submitOk = await page.evaluate(() => {
      const candidates = document.querySelectorAll(
        '.pass-button-submit, ' +
        '.pass-button[class*="submit"], ' +
        'a[class*="submit"], span[class*="submit"], div[class*="submit"]'
      );
      for (const el of candidates) {
        if (el.offsetParent !== null) { el.click(); return true; }
      }
      // 兜底：找任何可见的「登录」文字元素
      const all = document.querySelectorAll('a, span, div, button, p');
      for (const el of all) {
        if (el.offsetParent !== null && el.innerText?.trim() === '登录') {
          el.click(); return true;
        }
      }
      return false;
    });

    if (!submitOk) {
      console.log('未找到可见按钮，使用 form.submit()...');
      await page.evaluate(() => {
        const form = document.querySelector('#TANGRAM__PSP_4__form') || document.querySelector('form');
        if (form) form.submit();
      });
    }

    // 等待 OAuth 重定向到 miaoda.cn
    console.log('等待 OAuth 跳转...');
    try {
      await page.waitForURL(url => url.includes('miaoda.cn'), { timeout: 30000 });
      console.log('跳转成功:', page.url().slice(0, 80));
    } catch {
      console.log('当前页面:', page.url().slice(0, 80));
    }

    // 等待 SPA 加载
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // 验证登录
    const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
    console.log('页面文字:', pageText.replace(/\n/g, ' '));
    const loggedIn = /退出|注销|我的|个人中心|账户|额度|余额/i.test(pageText);

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
