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

    // —————— Cookie 验证 ——————
    const cached = loadCachedCookies();
    if (cached) {
      await context.addCookies(cached);
      console.log('使用缓存 Cookie，访问 miaoda.cn...');
      await page.goto('https://www.miaoda.cn/', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      console.log('当前页面:', page.url().slice(0, 80));

      // 验证 Cookie 是否真的有效
      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
      console.log('页面文字:', pageText.replace(/\n/g, ' '));
      const loggedIn = /退出|注销|我的|个人中心|账户|额度|余额/i.test(pageText);

      if (loggedIn) {
        console.log('Cookie 有效，已登录');
        return;
      }
      console.log('Cookie 已过期，重新登录');
    }

    // —————— 登录 ——————
    console.log('前往 passport.baidu.com 获取表单参数...');
    await page.goto(
      'https://passport.baidu.com/v2/?login&u=https://www.miaoda.cn/',
      { waitUntil: 'load', timeout: 60000 }
    ).catch(() => {});

    // 等待表单
    console.log('等待表单...');
    try {
      await page.waitForSelector('#TANGRAM__PSP_3__userName', { state: 'attached', timeout: 60000 });
    } catch {
      throw new Error('表单未加载');
    }
    console.log('表单已就绪');

    // 收集表单全部字段 + 调用 passport 登录 API
    console.log('调用登录 API...');
    const loginResult = await page.evaluate(async (creds) => {
      const id = (name) => `TANGRAM__PSP_3__${name}`;
      const getVal = (name) => {
        const el = document.getElementById(id(name));
        return el ? el.value : '';
      };

      const body = new URLSearchParams({
        staticPage: getVal('staticPage') || 'https://passport.baidu.com/static/passpc-account/html/v3Jump.html',
        charset: getVal('charset') || 'utf-8',
        token: getVal('token') || '',
        tpl: getVal('tpl') || 'pp',
        subpro: getVal('subpro') || '',
        apiver: getVal('apiver') || 'v3',
        tt: getVal('tt') || String(Date.now()),
        codestring: getVal('codestring') || '',
        safeflag: getVal('safeFlag') || '0',
        isPhone: getVal('isPhone') || 'false',
        quickUser: getVal('quick_user') || '',
        logLoginType: getVal('logLoginType') || 'loginLog',
        idc: getVal('idc') || '',
        loginMerge: getVal('loginMerge') || '',
        gid: getVal('gid') || '',
        u: getVal('u') || '',
        memPass: 'on',
        username: creds.username,
        password: creds.password,
        loginType: '1',
        detect: '1',
        ppui_logintime: String(Date.now()),
        callback: 'parent.bd__pcbs__' + Date.now(),
      });

      const res = await fetch('https://passport.baidu.com/v2/api/?login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'include',
      });

      const text = await res.text();

      // 从 JSONP 或 HTML 响应中提取 OAuth 跳转 URL
      let redirectUrl = '';
      try {
        const m = text.match(/bd__pcbs__\d+\((.+)\)/);
        if (m) {
          const data = JSON.parse(m[1]);
          redirectUrl = data?.data?.redirectUrl || data?.data?.u || '';
        }
      } catch {}
      if (!redirectUrl) {
        const m = text.match(/var href\s*=\s*(?:decodeURIComponent\(['"]?)?([^'")\s;]+)/);
        if (m) redirectUrl = decodeURIComponent(m[1]);
      }
      if (!redirectUrl) {
        const m = text.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (m) redirectUrl = m[1];
      }

      return { ok: res.ok, body: text.slice(0, 2000), redirectUrl };
    }, creds);

    console.log('API 响应体:', loginResult.body);
    console.log('提取的重定向 URL:', loginResult.redirectUrl);
    if (!loginResult.ok && !loginResult.redirectUrl) {
      throw new Error('登录 API 失败');
    }

    // 导航到 OAuth 跳转 URL（完成从 passport 到 miaoda 的授权链）
    const target = loginResult.redirectUrl || 'https://www.miaoda.cn/';
    console.log('完成 OAuth 跳转到:', target.slice(0, 80));
    await page.goto(target, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    console.log('当前页面:', page.url().slice(0, 80));

    // 验证登录状态
    const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
    console.log('页面文字:', pageText.replace(/\n/g, ' '));
    const loggedIn = /退出|注销|我的|个人中心|账户|额度|余额/i.test(pageText);

    if (!loggedIn) {
      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
      console.log('页面文字:', pageText.replace(/\n/g, ' '));
      throw new Error('登录验证失败');
    }
    console.log('登录验证通过');

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
