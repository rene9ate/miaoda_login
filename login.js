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

  // 最终目标：直接访问 iaas 或 miaoda 做验证
  const targetChecks = [
    { match: '**/console.bce.baidu.com/**', label: 'console.bce' },
    { match: '**/www.miaoda.cn/**', label: 'miaoda.cn' },
    { match: '**/passport.baidu.com/**?login*', label: 'passport.login', isLogin: true },
  ];

  const loginUrl = 'https://login.bce.baidu.com/?redirect=https%3A%2F%2Fconsole.bce.baidu.com%2Fapi%2Fiam%2Foauth2%2Fconnect%3Fclient_id%3Ddb7e162f32a6484a8b0db889b6f37836%26response_type%3Dcode%26redirect_uri%3Dhttps%253A%252F%252Fwww.miaoda.cn%252Foauth2%252Fcallback%252Fiam%253Fredirect_uri%253D%25252F%25253Ftrack_id%25253Dpromolink-aj1ejsa8hn9c%26scope%3Duser_info%26state%3Dac3b67c9-d169-4cd9-be9c-fc0dbc08f926%26from%3Doa_db7e162f32a6484a8b0db889b6f37836%26iam_state%3Dauth&from=oa_db7e162f32a6484a8b0db889b6f37836';
  const finalTarget = 'https://console.bce.baidu.com/';

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

  // 轻量 jQuery 桩：保留 TANGRAM 所需的 $.extend / .append
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/jquery/i.test(url)) {
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `
window.$ = function (s) {
  var e = typeof s === 'string' ? document.querySelectorAll(s) : s || [];
  return Object.assign(Array.from(e), {
    val: function (v) {
      if (v === undefined) return this[0]?.value;
      this.forEach(function (x) { x.value = v; });
      return this;
    },
    on: function (e, f) {
      this.forEach(function (x) { x.addEventListener(e, f); });
      return this;
    },
    click: function (f) {
      if (f) this.on('click', f);
      else this[0]?.click();
      return this;
    },
    attr: function (n, v) {
      if (v === undefined) return this[0]?.getAttribute(n);
      this.forEach(function (x) { x.setAttribute(n, v); });
      return this;
    },
    each: function (f) {
      for (var i = 0; i < this.length; i++) f.call(this[i], i, this[i]);
      return this;
    },
    find: function (s) {
      var r = [];
      this.forEach(function (x) { r.push.apply(r, x.querySelectorAll(s)); });
      return window.$(r);
    },
    trigger: function (e) {
      this.forEach(function (x) { x.dispatchEvent(new Event(e, { bubbles: true })); });
      return this;
    },
    append: function (c) {
      this.forEach(function (x) {
        if (typeof c === 'string') x.insertAdjacentHTML('beforeend', c);
        else if (c.nodeType) x.appendChild(c);
      });
      return this;
    },
    remove: function () {
      this.forEach(function (x) { x.parentNode?.removeChild(x); });
      return this;
    },
    text: function (t) {
      if (t === undefined) return this.map(function (x) { return x.textContent; }).join('');
      this.forEach(function (x) { x.textContent = t; });
      return this;
    },
    html: function (h) {
      if (h === undefined) return this[0]?.innerHTML;
      this.forEach(function (x) { x.innerHTML = h; });
      return this;
    },
    css: function (prop, val) {
      if (val === undefined) return this[0]?.style[prop];
      this.forEach(function (x) { x.style[prop] = val; });
      return this;
    },
    show: function () { this.forEach(function (x) { x.style.display = ''; }); return this; },
    hide: function () { this.forEach(function (x) { x.style.display = 'none'; }); return this; },
    addClass: function (c) { this.forEach(function (x) { x.classList.add(c); }); return this; },
    removeClass: function (c) { this.forEach(function (x) { x.classList.remove(c); }); return this; },
    toggleClass: function (c) { this.forEach(function (x) { x.classList.toggle(c); }); return this; },
    hasClass: function (c) { return this.some(function (x) { return x.classList.contains(c); }); },
    parent: function () { return window.$(this[0]?.parentNode); },
    children: function () {
      var r = [];
      this.forEach(function (x) { r.push.apply(r, x.children); });
      return window.$(r);
    },
    siblings: function () {
      if (!this[0]) return window.$([]);
      return window.$(Array.from(this[0].parentNode.children).filter(function (c) { return c !== this[0]; }.bind(this)));
    },
    index: function () {
      if (!this[0]) return -1;
      return Array.from(this[0].parentNode.children).indexOf(this[0]);
    },
    data: function (k, v) {
      if (v === undefined) return this[0]?.dataset[k];
      this.forEach(function (x) { x.dataset[k] = v; });
      return this;
    },
    serialize: function () {
      if (!this[0] || !this[0].elements) return '';
      return Array.from(this[0].elements).filter(function (e) { return e.name; }).map(function (e) {
        return encodeURIComponent(e.name) + '=' + encodeURIComponent(e.value);
      }).join('&');
    },
  });
};
window.$.extend = function () {
  var args = Array.from(arguments);
  var deep = typeof args[0] === 'boolean' ? args.shift() : false;
  var target = args.shift() || {};
  args.forEach(function (src) {
    if (!src) return;
    Object.keys(src).forEach(function (key) {
      if (deep && typeof src[key] === 'object' && src[key] !== null && !Array.isArray(src[key])) {
        if (!target[key]) target[key] = {};
        window.$.extend(true, target[key], src[key]);
      } else {
        target[key] = src[key];
      }
    });
  });
  return target;
};
window.$.each = function (arr, fn) {
  if (arr == null) return arr;
  for (var i = 0; i < arr.length; i++) {
    if (fn.call(arr[i], i, arr[i]) === false) break;
  }
  return arr;
};
window.$.trim = function (s) { return s == null ? '' : String(s).trim(); };
window.$.inArray = function (v, arr) { return arr.indexOf(v); };
window.$.map = function (arr, fn) {
  if (!arr) return [];
  var r = [];
  for (var i = 0; i < arr.length; i++) r.push(fn(arr[i], i));
  return r;
};
window.$.param = function (obj) {
  if (!obj) return '';
  return Object.keys(obj).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
  }).join('&');
};
window.$.ajax = function (opts) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    var method = (opts.type || 'GET').toUpperCase();
    xhr.open(method, opts.url);
    if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType);
    if (opts.dataType === 'json') xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = function () {
      var data = opts.dataType === 'json' ? JSON.parse(xhr.responseText) : xhr.responseText;
      if (opts.success) opts.success(data, xhr.statusText, xhr);
      resolve(data);
    };
    xhr.onerror = function () { if (opts.error) opts.error(xhr); reject(xhr); };
    xhr.send(opts.data || null);
  });
};
window.jQuery = window.$;
`.trim()
      });
    } else {
      route.continue();
    }
  });

  // —————— 1. 直接访问 console.bce.baidu.com 验证 Cookie ——————
  const cached = loadCachedCookies();
  if (cached) {
    await context.addCookies(cached);
    console.log('发现缓存 Cookie，直接访问目标...');
    await page.goto(finalTarget, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const afterUrl = page.url();
    // 如果最终没被踢回 login 页，就算有效
    if (!afterUrl.includes('login')) {
      console.log('Cookie 有效');
      saveCookies(cached);
      await browser.close();
      return;
    }
    console.log('Cookie 已过期，重新登录');
  }

  // —————— 2. 去 BCE 登录页 ——————
  console.log('前往登录页...');
  await page.goto(loginUrl, { waitUntil: 'load', timeout: 120000 }).catch(() => {});

  console.log('等待页面加载...');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const hasForm = await page.evaluate(() => {
      return !!document.getElementById('TANGRAM__PSP_4__userName') ||
             !!document.getElementById('TANGRAM__PSP_3__userName');
    }).catch(() => false);
    if (hasForm) { ready = true; break; }
    const url = page.url();
    // 如果被重定向到非登录页，提前退出
    if (!url.includes('login') && !url.includes('passport')) {
      console.log('已被重定向，URL:', url);
      ready = true;
      break;
    }
    if (i % 10 === 0) console.log(`等待表单... url=${url} i=${i + 1}/90`);
    await page.waitForTimeout(2000);
  }
  console.log();

  const currentUrl = page.url();
  // 已被重定向 → 无需登录
  if (!currentUrl.includes('login') && !currentUrl.includes('passport')) {
    console.log('无需登录，已跳转到:', currentUrl);
    const cookies = await context.cookies();
    saveCookies(cookies);
    await browser.close();
    return;
  }

  if (!ready) {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500)).catch(() => 'N/A');
    console.error('表单未加载 - 内容:', text);
    process.exit(1);
  }

  console.log('表单已就绪');

  // 自动检测 TANGRAM 版本
  const version = await page.evaluate(() => {
    if (document.getElementById('TANGRAM__PSP_4__userName')) return '4';
    if (document.getElementById('TANGRAM__PSP_3__userName')) return '3';
    return null;
  });
  console.log(`TANGRAM 版本: PSP_${version}`);
  if (!version) {
    console.error('未找到登录表单');
    process.exit(1);
  }

  console.log('填写表单...');
  const fillResult = await page.evaluate(({ version, username, password }) => {
    const id = (name) => `TANGRAM__PSP_${version}__${name}`;
    const u = document.getElementById(id('userName'));
    const p = document.getElementById(id('password'));
    if (!u || !p) return '未找到输入框';

    u.value = username;
    u.dispatchEvent(new Event('input', { bubbles: true }));
    p.value = password;
    p.dispatchEvent(new Event('input', { bubbles: true }));

    const cb = document.getElementById(id('memberPass'));
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return 'ok';
  }, { version, ...creds });
  console.log('填写结果:', fillResult);
  if (fillResult !== 'ok') {
    console.error('填写失败:', fillResult);
    process.exit(1);
  }

  await page.waitForTimeout(1000);

  console.log('提交登录...');
  await page.evaluate((version) => {
    const id = (name) => `TANGRAM__PSP_${version}__${name}`;
    const form = document.getElementById(id('form'));
    if (form) {
      form.requestSubmit();
      return;
    }
    const btn = document.getElementById(id('submit'));
    if (btn) btn.click();
  }, version);

  await page.waitForTimeout(5000);

  console.log('等待登录完成...');

  let loginDone = false;
  let currentUrl2 = '';
  for (let i = 0; i < 30; i++) {
    currentUrl2 = page.url();
    if (!currentUrl2.includes('passport.baidu.com') && !currentUrl2.includes('login')) {
      loginDone = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (loginDone) {
    console.log('登录成功，当前 URL:', currentUrl2 || page.url());
  } else {
    const errInfo = await page.evaluate(() => {
      const errEl = document.querySelector('.pass-error, .error, .errmsg, [class*="error"], .tip');
      const errText = errEl?.textContent?.trim();
      const allText = document.body?.innerText?.slice(0, 1000);
      return { errText, allText };
    }).catch(() => ({}));
    console.error('登录失败 - 错误:', errInfo.errText);
    console.error('页面内容:', errInfo.allText);
    process.exit(1);
  }

  const cookies = await context.cookies();
  saveCookies(cookies);

  await browser.close();
})();
