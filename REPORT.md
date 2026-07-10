# 秒搭 (miaoda.cn) 自动登录项目复盘

## 目标

通过 GitHub Actions 每天早上自动登录秒搭（miaoda.cn，基于百度智能云 IAM OAuth），领取每日赠送的秒点额度。

## 技术栈

- **Playwright** — 浏览器自动化
- **GitHub Actions** — 定时调度 + 无服务器执行环境
- **Node.js 20** — 脚本运行环境

## 技术要点

### 1. OAuth 登录流程

秒搭使用**百度智能云 IAM OAuth** 作为认证入口，流程如下：

```
miaoda.cn → 点登录 → login.bce.baidu.com (IAM OAuth) → 填写账号密码
→ passport.baidu.com API 验证 → OAuth 回调 → miaoda.cn 拿到登录态
```

不能直接调 `passport.baidu.com` API，必须从 `login.bce.baidu.com` 的 TANGRAM 表单提交，否则 OAuth state/code 会失效。

### 2. TANGRAM 表单机制

百度统一登录组件（TANGRAM）的特性：

- **原生 input 被隐藏**（`opacity: 0`, 0×0 尺寸），TANGRAM 创建 div 覆盖层接收用户输入
- **提交按钮也是隐藏的**，TANGRAM 通过 JS 监听覆盖层点击，再触发原生提交
- 表单字段包含 `token`、`gid`、`staticPage` 等隐藏字段，由 TANGRAM JS 动态注入
- 表单使用 `POST` 到 `passport.baidu.com/v2/api/?login`，但**不能直接 XHR**（CORS 拦截），必须用 form submit + 全页导航

### 3. CORS 与反爬

```
XHR/fetch → passport.baidu.com API  ❌ (No 'Access-Control-Allow-Origin')
form.submit() → passport.baidu.com  ✅ (全页导航，不触发 CORS)
```

TANGRAM 自身也使用 form POST（非 XHR）提交登录数据，浏览器全页导航到 passport API，服务器返回重定向。但由于 passport API 返回 JSON（非 302），直接 `form.submit()` 会导致浏览器无法渲染（404）。

### 4. CDN 不可达

`login.bce.baidu.com` 加载了以下 CDN 资源：

- `code.bdstatic.com/npm/jquery@3.5.0` — 被 Chrome 的 `document.write` 跨域策略警告
- `bce.bdstatic.com/portal-server/common/bce-storage.js` — GHA 环境超时

在 GHA（GitHub Actions Ubuntu runner）中，这些 CDN 经常 `ERR_TIMED_OUT`，导致 TANGRAM JS 无法初始化，表单 HTML 始终不渲染。

### 5. 页面的不一致性

BCE 登录页在不同时间返回了不同的版本：
- **TANGRAM 版**（ID 前缀 `TANGRAM__PSP_4__`）
- **CAS 版**（百度中央认证服务，加载 `cas.baidu.com` 脚本）

两种版本的表单 ID、字段名、提交流程完全不同，增加了自动化难度。

### 6. 极验（滑动验证码）

BCE 登录页在密码验证后会触发**滑动验证码（极验）**，Playwright 无法自动通过。这是项目终止的直接原因。

### 7. Playwright 反检测

使用 `addInitScript` 覆盖 `navigator.webdriver`、伪造 `navigator.plugins` 和 `languages`，可绕过基础的 headless 检测，但对极验无效。

### 8. GitHub Actions 调试技巧

- `actions/cache@v4` 缓存 Playwright Chromium（~260MB，静态 key 避免反复下载）
- `workflow_dispatch` 支持手动输入凭据调试
- `--debug` 参数切换有头模式 + `slowMo` 500ms 本地观察

## 困难与投入

| 阶段 | 问题 | 处理结果 |
|------|------|----------|
| TANGRAM 表单加载 | CDN 在 GHA 超时，表单不渲染 | 重试 3 次后部分缓解 |
| TANGRAM 表单填充 | 原生 input 隐藏，Playwright fill() 不可用 | 改用 page.evaluate 设值 + 触发事件 |
| 提交登录 | CORS 阻止 XHR，form.submit() 返回 JSON | 需要更复杂的提交策略 |
| 极验 | 滑动验证码需要打码平台介入 | 成本高，不值得继续 |
| CAS 新页面 | 表单 ID 不同，页面版本不稳定 | 需要持续维护选择器 |

## 可借鉴的经验

1. **OAuth 流程不要绕过** — 浏览器整页导航比 XHR 更接近真实用户，且不受 CORS 限制
2. **CDN 问题是 GHA 常态** — 国内 CDN 在 GitHub Actions 中不稳定，需要重试 + 路由兜底
3. **反检测可以做** — `addInitScript` + 伪造 `webdriver`/`plugins`/`languages` 能过基础检测
4. **Playwright 调试模式** — `--debug` 切换有头 + slowMo 对本地排查卡点很有用

## 如果继续

1. **打码平台** — 接入 2captcha/超级鹰 处理极验，但成本 > 收益（每天几毛钱的秒点）
2. **替代登录** — 检查秒哒是否提供 token 续期或 API Key 方式（不需要浏览器）
3. **本地跑 + 定时** — 在自己电脑上跑，避免 GHA 的 CDN 和 IP 问题，但极验仍然存在
