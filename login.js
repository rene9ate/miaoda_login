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
      console.log('使用缓存 Cookie');
      return;
    }

    // —————— 登录 ——————
    console.log('前往 passport.baidu.com...');
    await page.goto('https://passport.baidu.com/v2/?login', { waitUntil: 'load', timeout: 60000 }).catch(() => {});

    // 等待 TANGRAM 表单出现
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
    if (!ready) throw new Error('表单未加载');
    console.log('表单已就绪');

    // 提取表单需要的全部字段 + 调用登录 API
    console.log('调用登录 API...');
    const result = await page.evaluate(async (creds) => {
      const id = (name) => `TANGRAM__PSP_3__${name}`;

      const getVal = (name) => {
        const el = document.getElementById(id(name));
        return el ? el.value : '';
      };

      const staticPage = getVal('staticPage') || 'https://passport.baidu.com/static/passpc-account/html/v3Jump.html';
      const charset = getVal('charset') || 'utf-8';
      const token = getVal('token') || '';
      const tpl = getVal('tpl') || 'pp';
      const subpro = getVal('subpro') || '';
      const apiver = getVal('apiver') || 'v3';
      const tt = getVal('tt') || String(Date.now());
      const codestring = getVal('codestring') || '';
      const safeflag = getVal('safeFlag') || '0';
      const isPhone = getVal('isPhone') || 'false';
      const quickUser = getVal('quick_user') || '';
      const logLoginType = getVal('logLoginType') || 'loginLog';
      const idc = getVal('idc') || '';
      const loginMerge = getVal('loginMerge') || '';
      const gid = getVal('gid') || '';
      const u = getVal('u') || '';
      const memPass = 'on';
      const username = creds.username;
      const password = creds.password;
      const loginType = '1';
      const detect = '1';

      const body = new URLSearchParams({
        staticPage, charset, token, tpl, subpro, apiver, tt,
        codestring, safeflag, isPhone, quickUser, logLoginType,
        idc, loginMerge, gid, u, memPass,
        username, password, loginType, detect,
        ppui_logintime: String(Date.now()),
        callback: 'parent.bd__pcbs__' + Date.now(),
      });

      try {
        const res = await fetch('https://passport.baidu.com/v2/api/?login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          body: body.toString(),
          credentials: 'include',
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, body: text.slice(0, 2000) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }, creds);
    console.log('API 响应:', JSON.stringify(result));

    if (!result.ok) throw new Error('登录失败');

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
