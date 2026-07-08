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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
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

    // —————— BCE OAuth 登录 ——————
    console.log('前往 BCE 登录页...');
    await page.goto(BCE_LOGIN_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    console.log('当前页面:', page.url().slice(0, 80));

    // 等待表单出现
    console.log('等待登录表单...');
    try {
      await page.waitForSelector('#TANGRAM__PSP_3__userName', { state: 'attached', timeout: 15000 });
    } catch {
      // 可能用了不同的 TANGRAM 实例 ID，尝试搜索任何可见输入框
      await page.waitForSelector('input[type="text"]', { state: 'attached', timeout: 15000 });
    }
    console.log('表单就绪');

    // 填入用户名密码
    await page.evaluate(({ username, password }) => {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };

      // 尝试 TANGRAM 标准 ID
      let userEl = document.getElementById('TANGRAM__PSP_3__userName');
      if (!userEl) {
        // 回退到第一个文本输入框
        const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
        userEl = inputs[0];
      }
      if (userEl) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(userEl, username);
        userEl.dispatchEvent(new Event('input', { bubbles: true }));
        userEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      let passEl = document.getElementById('TANGRAM__PSP_3__password');
      if (!passEl) {
        const inputs = document.querySelectorAll('input[type="password"]');
        passEl = inputs[0];
      }
      if (passEl) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(passEl, password);
        passEl.dispatchEvent(new Event('input', { bubbles: true }));
        passEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 勾选协议（勾选包含"秒哒"或"百度"的 checkbox）
      document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        const label = (cb.closest('label') || {}).innerText || '';
        const parent = (cb.closest('div,span,p') || {}).innerText || '';
        const text = label + parent;
        if (/秒哒|百度|协议|隐私|同意/i.test(text)) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }, { username: creds.username, password: creds.password });

    // 提交登录
    console.log('提交登录...');
    await page.evaluate(() => {
      const btn = document.getElementById('TANGRAM__PSP_3__submit');
      if (btn) { btn.click(); return; }
      const btns = document.querySelectorAll('input[type="submit"], button[type="submit"]');
      if (btns.length) btns[0].click();
    });

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
