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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  await page.route('**/*', route => {
    const url = route.request().url();
    if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|mp4|webm|avi|mp3|pdf)$/i.test(url) ||
        /(hm\.baidu|analytics)/i.test(url)) {
      route.abort();
    } else if (/jquery/i.test(url)) {
      route.fulfill({ status: 200, contentType: 'application/javascript', body: `
        window.jQuery = window.$ = function(sel) {
          var el = typeof sel === 'function' ? null : document.querySelectorAll(sel);
          return Object.assign(el || [], {
            ready: function(f) { if (typeof sel === 'function') sel(); if (f) f(); return this; },
            val: function(v) { if(v===undefined) return this[0]?.value; this.forEach(function(e){e.value=v;}); return this; },
            on: function(e,f) { this.forEach(function(el){el.addEventListener(e,f);}); return this; },
            attr: function(n,v) { if(v===undefined) return this[0]?.getAttribute(n); this.forEach(function(e){e.setAttribute(n,v);}); return this; },
            click: function(f) { if(f) this.on('click',f); else this[0]?.click(); return this; },
            find: function(s) { var r=[]; this.forEach(function(e){r.push.apply(r,e.querySelectorAll(s));}); return window.$.call(null,r); },
            each: function(f) { for(var i=0;i<this.length;i++) f.call(this[i],i,this[i]); return this; },
            removeClass: function(c) { this.forEach(function(e){e.classList.remove(c);}); return this; },
            addClass: function(c) { this.forEach(function(e){e.classList.add(c);}); return this; },
            trigger: function(e,t) { this.forEach(function(el){el.dispatchEvent(new Event(e,{bubbles:true}));}); return this; },
          });
        };
        window.jQuery.ready = window.$.ready = function(f) { if (document.readyState!=='loading') f(); else document.addEventListener('DOMContentLoaded',f); };
        window.jQuery.support = {};
        $.ajax = function(o) { return fetch(o.url,{method:o.type||'GET',body:o.data}).then(function(r){return r.json();}).catch(function(){}); };
      `});
    } else {
      route.continue();
    }
  });

  const cached = loadCachedCookies();
  if (cached) {
    await context.addCookies(cached);
    console.log('发现缓存 Cookie，尝试直接访问');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
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

  await page.goto(loginUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});

  let ready = false;
  for (let i = 0; i < 90; i++) {
    const hasForm = await page.evaluate(() => !!document.getElementById('TANGRAM__PSP_4__userName')).catch(() => false);
    if (hasForm) { ready = true; break; }
    // also check iframes
    const frameForm = await page.evaluate(() => {
      for (const f of document.querySelectorAll('iframe')) {
        try {
          if (f.contentDocument?.getElementById('TANGRAM__PSP_4__userName')) return true;
        } catch(e) {}
      }
      return false;
    }).catch(() => false);
    if (frameForm) { ready = true; break; }
    const htmlLen = await page.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
    if (i % 10 === 0) console.log(`等待表单... body=${htmlLen}B i=${i + 1}/90`);
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

  console.log('等待跳转...');

  try {
    await page.waitForURL(targetPattern, { timeout: 60000 });
    console.log('登录成功，当前 URL:', page.url());
  } catch {
    const stillThere = await page.evaluate(() => !!document.getElementById('TANGRAM__PSP_4__userName')).catch(() => false);
    if (stillThere) {
      const err = await page.evaluate(() => document.querySelector('.pass-error')?.textContent?.trim()).catch(() => null);
      console.error('登录失败:', err || '仍在登录页面，可能密码/账号错误');
    } else {
      console.error('当前 URL:', page.url());
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 800)).catch(() => 'N/A');
      console.error('页面内容:', text);
    }
    process.exit(1);
  }

  const cookies = await context.cookies();
  saveCookies(cookies);

  await browser.close();
})();
