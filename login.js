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

      // 验证 Cookie 是否真的有效：尝试导航到需要认证的页面
      const loggedIn = await page.evaluate(() => {
        const text = document.body?.innerText?.slice(0, 500) || '';
        // 如果有登录/注册按钮但无用户相关文字，则未登录
        const hasLoginBtn = /登录|注册|sign.?in/i.test(text);
        const hasUserInfo = /退出|注销|我的|个人中心|账户|额度|余额/i.test(text);
        return hasUserInfo || !hasLoginBtn;
      }).catch(() => false);

      if (loggedIn) {
        console.log('Cookie 有效，已登录');
        return;
      }
      console.log('Cookie 已过期，重新登录');
    }

    // —————— 登录 ——————
    console.log('前往 passport.baidu.com（携带跳转参数）...');
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

    // 填写凭据（force 跳过可见性检查，TANGRAM 隐藏了原生 input）
    await page.locator('#TANGRAM__PSP_3__userName').fill(creds.username, { force: true });
    await page.locator('#TANGRAM__PSP_3__password').fill(creds.password, { force: true });

    const memCheck = await page.$('#TANGRAM__PSP_3__memberPass');
    if (memCheck) {
      const checked = await memCheck.isChecked();
      if (!checked) await memCheck.check();
    }

    // 提交表单并等待 OAuth 重定向到 miaoda.cn
    console.log('提交登录...');
    const redirectPromise = page.waitForURL(
      url => url.includes('miaoda.cn'),
      { timeout: 30000 }
    ).catch(() => {});
    await page.click('#TANGRAM__PSP_3__submit');
    await redirectPromise;

    // 等待 SPA 加载
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    console.log('当前页面:', page.url().slice(0, 80));

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
