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
    if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|mp4|webm|avi)$/i.test(url)) {
      route.abort();
    } else if (/jquery/i.test(url)) {
      const stub = `
        window.jQuery = window.$ = function(sel) { return document.querySelectorAll(sel); };
        $.fn = $.prototype = { 
          ready: function(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); },
          each: function(fn) { for (var i=0;i<this.length;i++) fn.call(this[i],i,this[i]); },
          val: function(v) { if (v===undefined) return this[0]?.value; this.each(e=>e.value=v); return this; },
          on: function(e,fn) { this.each(el=>el.addEventListener(e,fn)); return this; },
          off: function(e,fn) { this.each(el=>el.removeEventListener(e,fn)); return this; },
          click: function(fn) { this.each(el=>el.addEventListener('click',fn)); return this; },
          submit: function() { this.each(el=>el.form?.submit()); return this; },
          serialize: function() { return Array.from(this[0]?.elements||[]).filter(e=>e.name).map(e=>e.name+'='+encodeURIComponent(e.value)).join('&'); },
          attr: function(n,v) { if(v===undefined) return this[0]?.getAttribute(n); this.each(e=>e.setAttribute(n,v)); return this; },
          removeAttr: function(n) { this.each(e=>e.removeAttribute(n)); return this; },
          addClass: function(c) { this.each(e=>e.classList.add(c)); return this; },
          removeClass: function(c) { this.each(e=>e.classList.remove(c)); return this; },
          hasClass: function(c) { return this[0]?.classList.contains(c); },
          css: function(p,v) { if(v===undefined) return this[0]?.style[p]; this.each(e=>e.style[p]=v); return this; },
          data: function(k,v) { if(v===undefined) return this[0]?.[k]; this.each(e=>e[k]=v); return this; },
          remove: function() { this.each(e=>e.parentNode?.removeChild(e)); return this; },
          find: function(s) { var r=[]; this.each(e=>r.push(...e.querySelectorAll(s))); return $(r); },
          closest: function(s) { return this[0]?.closest(s); },
          parent: function() { return this[0]?.parentNode; },
          children: function() { return this[0]?.children; },
          siblings: function() { var p=this[0]?.parentNode; return p?$(Array.from(p.children).filter(c=>c!==this[0])):$({length:0}); },
          index: function() { var p=this[0]?.parentNode; return p?Array.from(p.children).indexOf(this[0]):-1; },
          trigger: function(e) { this.each(el=>el.dispatchEvent(new Event(e,{bubbles:true}))); return this; }
        };
        $.extend = function(o) { Object.assign($.fn, o); };
        $.ajax = function(opt) { return fetch(opt.url,{method:opt.type||'GET',body:opt.data}).then(r=>r.json()); };
        $.getJSON = function(u,d,c) { return $.ajax({url:u,data:d,success:c}); };
        window.jQuery = window.$;
      `;
      route.fulfill({ status: 200, contentType: 'application/javascript', body: stub });
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

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {
    console.warn('goto 超时，开始轮询等待渲染');
  });

  let ready = false;
  for (let i = 0; i < 90; i++) {
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (text.includes('百度账号') || text.includes('账号登录')) { ready = true; break; }
    const htmlLen = await page.evaluate(() => document.body?.innerHTML?.length || 0).catch(() => 0);
    if (i % 10 === 0) console.log(`等待渲染... body=${htmlLen}B i=${i + 1}/90`);
    await page.waitForTimeout(2000);
  }
  console.log();

  if (!ready) {
    const url = page.url();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => 'N/A');
    console.error('页面未渲染 - URL:', url, '内容:', text);
    process.exit(1);
  }

  console.log('页面已渲染，查找登录标签...');

  const tabs = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    return [...all]
      .filter(e => e.offsetParent !== null && e.textContent?.trim())
      .map(e => ({
        text: e.textContent?.trim()?.slice(0, 60),
        tag: e.tagName,
        id: e.id,
        class: e.className?.slice(0, 30),
      }));
  });
  console.log('所有可见元素:', JSON.stringify(tabs, null, 2));

  const loginTabs = tabs.filter(t => /账号登录|密码登录/.test(t.text));
  console.log('登录相关可见元素:', JSON.stringify(loginTabs, null, 2));

  const tabClicked = await page.evaluate(() => {
    const all = document.querySelectorAll('div, span, a, li, label, button, p, section');
    const el = [...all].find(e => {
      if (e.offsetParent === null) return false;
      const t = e.textContent?.trim() || '';
      return t === '账号登录' || t === '密码登录' || /^账号登录/.test(t);
    });
    if (el) { el.click(); return true; }

    const el2 = [...all].find(e => {
      if (e.offsetParent === null) return false;
      return e.textContent?.includes('账号') && e.textContent?.includes('登录');
    });
    if (el2) { el2.click(); return true; }
    return false;
  });
  console.log(tabClicked ? '已点击账号登录标签' : '未找到账号登录标签');

  let found = false;
  for (let i = 0; i < 30; i++) {
    found = await page.evaluate(() => !!document.getElementById('uc-common-account')).catch(() => false);
    if (found) break;
    await page.waitForTimeout(2000);
  }

  if (!found) {
    const title = await page.title().catch(() => 'N/A');
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => 'N/A');
    console.error('表单未加载 - 标题:', title, '内容:', text);
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
  await page.waitForTimeout(500);

  const agreeText = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div, span, label, i, em')].find(e =>
      /阅读并同意|用户协议|隐私政策/.test(e.textContent) && e.offsetParent !== null
    );
    if (el) { el.click(); return '已点同意'; }
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); return '已勾选框'; }
    return '未找到同意';
  });
  console.log('协议处理:', agreeText);
  await page.waitForTimeout(500);

  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button, [role="button"]')]
      .filter(e => e.offsetParent !== null)
      .map(e => ({ text: e.textContent?.trim()?.slice(0, 30), id: e.id, type: e.type }))
  );
  console.log('可见按钮:', JSON.stringify(buttons, null, 2));

  let loginBtn = buttons.find(b => /登录|submit/.test(b.text || ''));
  let btnId = loginBtn?.id;

  if (!btnId) {
    const all = await page.evaluate(() =>
      [...document.querySelectorAll('button')].map(e => ({ text: e.textContent?.trim()?.slice(0, 30), id: e.id }))
    );
    console.log('所有按钮:', JSON.stringify(all, null, 2));
    loginBtn = all.find(b => /登录|submit/.test(b.text || ''));
    btnId = loginBtn?.id;
  }

  if (!btnId) {
    console.error('未找到登录按钮');
    process.exit(1);
  }

  await page.click('#' + btnId);
  console.log('已点击登录按钮:', loginBtn?.text);
  await page.waitForTimeout(2000);

  try {
    await page.waitForURL(targetPattern, { timeout: 60000 });
    console.log('登录成功');
    const cookies = await context.cookies();
    saveCookies(cookies);
  } catch {
    console.error('当前 URL:', page.url());
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 800)).catch(() => 'N/A');
    console.error('页面内容:', text);
    process.exit(1);
  }

  await browser.close();
})();
