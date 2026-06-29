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

  const loginUrl = 'https://passport.baidu.com/v2/?login';
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

  page.on('pageerror', err => console.error('[页面异常]', err.message));

  await page.route('**/*', route => {
    const url = route.request().url();
    if (/jquery/i.test(url)) {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.$=function(s){var e=typeof s==="string"?document.querySelectorAll(s):s||[];return Object.assign(Array.from(e),{val:function(v){if(v===undefined)return this[0]?.value;this.forEach(function(x){x.value=v;});return this;},on:function(e,f){this.forEach(function(x){x.addEventListener(e,f);});return this;},click:function(f){if(f)this.on("click",f);else this[0]?.click();return this;},attr:function(n,v){if(v===undefined)return this[0]?.getAttribute(n);this.forEach(function(x){x.setAttribute(n,v);});return this;},each:function(f){for(var i=0;i<this.length;i++)f.call(this[i],i,this[i]);return this;},find:function(s){var r=[];this.forEach(function(x){r.push.apply(r,x.querySelectorAll(s));});return window.$(r);},trigger:function(e){this.forEach(function(x){x.dispatchEvent(new Event(e,{bubbles:true}));});return this;}});};window.jQuery=window.$;' });
    } else {
      route.continue();
    }
  });

  const cached = loadCachedCookies();
  if (cached) {
    await context.addCookies(cached);
    console.log('发现缓存 Cookie，尝试直接访问');
    await page.goto(loginUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
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

  await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => {});

  console.log('等待页面加载...');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(() => {
      const hasForm = !!document.getElementById('TANGRAM__PSP_4__userName');
      const all = [...document.querySelectorAll('*')].filter(e => e.offsetParent !== null && e.textContent?.trim());
      const linkEl = all.find(e => /用户名登录/.test(e.textContent?.trim()));
      const linkTexts = all.filter(e => /用户/.test(e.textContent)).map(e => e.textContent?.trim()?.slice(0, 30));
      return { hasForm, hasLink: !!linkEl, linkTexts: linkTexts.slice(0, 10) };
    }).catch(() => ({ hasForm: false, hasLink: false, linkTexts: [] }));
    
    if (state.hasForm) { ready = true; break; }
    
    if (state.hasLink && i === 0) {
      console.log('找到用户名登录，先检查页面输入框...');
      const inputs = await page.evaluate(() =>
        [...document.querySelectorAll('input')].map(el => ({
          id: el.id, name: el.name, type: el.type, placeholder: el.placeholder,
          className: el.className?.slice(0, 40)
        }))
      );
      console.log('页面 inputs:', JSON.stringify(inputs, null, 2));
    }
    
    if (state.hasLink && i < 3) {
      console.log('点击用户名登录...');
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('a, span, div, label, button')].find(e =>
          /用户名登录/.test(e.textContent?.trim()) && e.offsetParent !== null
        );
        if (el) el.click();
      });
      await page.waitForTimeout(5000);
    }
    
    if (i % 10 === 0) console.log(`等待... hasLink=${state.hasLink} linkTexts=${JSON.stringify(state.linkTexts)} i=${i + 1}/60`);
    await page.waitForTimeout(2000);
  }
  console.log();

  if (!ready) {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => 'N/A');
    console.error('表单未加载 - 内容:', text);
    process.exit(1);
  }

  console.log('表单已就绪');

  console.log('填写表单...');
  const fillResult = await page.evaluate(({ username, password }) => {
    // 优先 TANGRAM 老版（原用户脚本用的）
    let u = document.getElementById('TANGRAM__PSP_4__userName');
    let p = document.getElementById('TANGRAM__PSP_4__password');
    let formType = 'tangram';

    if (!u || !p) {
      // 回退：新版 BCE 表单
      u = document.getElementById('uc-common-account');
      p = document.getElementById('ucsl-password-edit') || document.getElementById('uc-common-password');
      formType = 'bce';
    }

    if (!u || !p) {
      return '未找到用户名/密码输入框';
    }

    u.value = username;
    u.dispatchEvent(new Event('input', { bubbles: true }));
    u.dispatchEvent(new Event('change', { bubbles: true }));

    p.value = password;
    p.dispatchEvent(new Event('input', { bubbles: true }));
    p.dispatchEvent(new Event('change', { bubbles: true }));

    // 勾选同意复选框
    const cbs = document.querySelectorAll('input[type="checkbox"]');
    cbs.forEach(cb => {
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });

    return 'ok: ' + formType;
  }, creds);
  console.log('填写结果:', fillResult);
  if (!fillResult.startsWith('ok')) {
    console.error('填写失败:', fillResult);
    process.exit(1);
  }

  await page.waitForTimeout(1000);

  console.log('提交登录...');
  const submitResult = await page.evaluate(() => {
    const btn = document.getElementById('TANGRAM__PSP_4__submit');
    if (!btn) return '未找到提交按钮';

    // 模拟真实点击
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

    // 备用：提交表单
    const form = btn.closest('form');
    if (form && !form.checkValidity()) return '表单验证失败';
    if (form) {
      setTimeout(() => { if (form) form.submit(); }, 500);
    }

    return '已触发点击';
  });
  console.log('提交结果:', submitResult);

  await page.waitForTimeout(3000);

  console.log('等待登录完成...');

  let loginDone = false;
  let currentUrl = '';
  for (let i = 0; i < 30; i++) {
    currentUrl = page.url();
    if (!currentUrl.includes('passport.baidu.com') && !currentUrl.includes('login')) {
      loginDone = true;
      break;
    }
    const formGone = await page.evaluate(() => !document.getElementById('TANGRAM__PSP_4__userName')).catch(() => false);
    if (formGone) {
      loginDone = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (loginDone) {
    console.log('登录成功，当前 URL:', currentUrl || page.url());
  } else {
    const err = await page.evaluate(() => document.querySelector('.pass-error')?.textContent?.trim()).catch(() => null);
    console.error('登录失败:', err || '超时或密码错误');
    process.exit(1);
  }

  const cookies = await context.cookies();
  saveCookies(cookies);

  await browser.close();
})();
