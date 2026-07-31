# Notepad Calculator

一个"记事本式计算器"(类似 Soulver / Numi):在右侧输入自然语言的数学表达式,左侧实时显示每一行的计算结果。

采用**混合架构**:前端本地规则引擎优先解析(免费、瞬时、离线可用);规则引擎解不出来、但看起来像计算的行,会异步兜底交给后端小服务调用通义千问(Qwen)大模型来算,尽量减少"算不出来"的情况。

## 运行方式

### 1. 前端(必须)

不需要构建工具,直接双击 `index.html` 用浏览器打开即可;也可以用本地静态服务器打开:

```bash
cd notepad
python3 -m http.server 8080
# 然后浏览器打开 http://localhost:8080
```

### 2. 后端兜底服务(可选,但推荐启动)

前端本地引擎解析不了的行,会自动请求这个后端服务,由通义千问(Qwen)兜底计算。不启动它也完全不影响本地规则能覆盖到的所有功能。

```bash
cd notepad/server
npm install
cp .env.example .env   # 已经帮你配置好了 .env,一般不需要重新复制
npm start               # 默认监听 http://localhost:8787
```

`.env` 里需要一个 `QWEN_API_KEY`(DashScope / 通义千问的 API Key,在 [DashScope 控制台](https://dashscope.console.aliyun.com/)获取)。

页面顶部有一个状态灯(`AI 兜底:在线/离线/缺少 Key/已关闭`),可以直接看出后端服务是否连上。

### 3. 100% 离线开关

页面顶部有一个 **AI 兜底** 开关,**默认关闭**。关闭时,页面**绝对不会**发起任何网络请求(不检测后端状态、不发送计算请求、也不展示之前缓存过的 AI 答案),只用本地规则引擎,行为完全可预测。

> 注意:即使 `server/server.js` 正在本机运行、`.env` 里也配了真实 Key,只要页面上这个开关是关的,就不会触发任何调用——"仓库里不提交 Key" 和 "页面上关掉 AI 开关" 是两件独立的事,前者保证 Key 不泄露到 git,后者保证你测试时不会意外用到 AI。想用 AI 兜底时,手动把开关打开即可,状态会实时刷新成 `在线`/`离线`/`缺少 Key`。

### 4. 部署到 Vercel(线上访问)

整个项目(前端静态页面 + AI 兜底后端)可以**零配置直接部署到 Vercel**,不需要额外的服务器:

- 静态页面(`index.html`/`app.js`/`engine.js`/`style.css`)会被当作静态资源直接托管
- `api/health.js`、`api/evaluate.js` 会被 Vercel 自动识别成 Serverless Function,和 `server/server.js` 走的是同一套逻辑(共享 `server/qwen.js`),线上环境下前端会自动改用同域的 `/api/...` 路径,不需要改代码

**步骤(网页操作,最简单)**:

1. 先确保代码已经推到 GitHub(见上面「推送到 Git」),然后打开 [vercel.com](https://vercel.com) → **Add New → Project** → 选择这个 GitHub 仓库(`notepadCalculator`)→ **Import**
2. Framework Preset 保持默认的 **Other** 即可,不需要设置 Build Command / Output Directory
3. 如果想要 AI 兜底在线上也能用,在 **Environment Variables** 里加一条 `QWEN_API_KEY`(值就是你本机 `server/.env` 里的那个 Key);不加的话线上也能正常访问,只是 AI 兜底状态灯会显示"缺少 Key",本地规则引擎覆盖的功能不受影响
4. 点 **Deploy**,几十秒后就会拿到一个 `xxx.vercel.app` 的线上地址

**或者用命令行**(需要先 `npm i -g vercel` 并 `vercel login` 登录你自己的账号):

```bash
cd notepad
vercel        # 首次运行会引导你关联/创建项目,按提示选默认值即可
vercel --prod # 部署到生产环境
```

部署之后,如果之后要更新 `QWEN_API_KEY` 等环境变量,去 Vercel 项目的 **Settings → Environment Variables** 改,改完需要重新部署一次(Redeploy)才会生效。

## 功能特性

- **逐行计算**:每一行单独解析,结果显示在左侧对应行
- **百分比**:`15% of 95`、`20 percent of 50`
- **求和 / 平均 / 最大 / 最小**:`sum of 4, 23.4, 45, 67, 90`、`average of 3, 4, 5`、`max of 1,2,3`、`min of 1,2,3`(也支持 `summary`、`total`、`add` 等同义词)
- **变量赋值与引用(支持多词变量名)**:
  ```
  price = 120
  tax = 8% of price
  price + tax

  daily snack cost = $5
  weekly snack cost = 7 * daily snack cost
  ```
  多词变量名不区分大小写、允许中间空白量不一致,引用时按最长匹配优先替换,避免 "cost" 误匹配到 "daily snack cost" 的一部分。
- **货币符号**:数字前的 `$`、`¥`、`£`、`€` 会被自动忽略,例如 `$5` 按 `5` 计算
- **单位换算**(基于 math.js 内置单位系统):`100 cm in m`、`5 kg in lb`、`2 hours in minutes`、`1 inch to cm`,`in`/`to` 都可以;支持长度、重量、时间等常见单位,也可以先赋值给变量再换算,如 `height = 180 cm` 之后 `height in m`。注意:货币(美元/人民币等)不是 math.js 的单位,货币换算走的是下面的 AI 兜底,不是本地引擎
- **日期推算**(100% 本地,不需要 AI 兜底):`today is 8 july`、`three days after today`、`one week after today`、`payday is 2026-08-15`、`5 days before payday`、`2 weeks from today`;不特别定义时 `today`/`tomorrow`/`yesterday` 默认对应真实当前日期,支持 `days/weeks/months/years` + `after/before/from`
- **自然语言运算符**:`plus`、`minus`、`times`、`divided by`、`multiplied by`、`over`
- **常规四则运算与括号**:`(10 + 5) * 2`
- **一元函数短语**:
  - `the decimal part of 10.2` → `0.2`
  - `the integer part of 10.2` / `whole part of 10.2` → `10`
  - `square root of 81` / `sqrt of 81` → `9`
  - `absolute value of -5` / `abs of -5` → `5`
  - `square of 4` → `16`,`cube of 2` → `8`
- **自动去除提问语气**:`what is 15% of 95?` 等价于 `15% of 95`
- **本地自动保存**:内容保存在浏览器 `localStorage`,刷新不丢失
- **一键清空 / 复制结果**

## 文件结构

- `index.html` — 页面结构
- `style.css` — 样式(白色主题、左右分栏、语法高亮配色)
- `engine.js` — 纯逻辑:自然语言解析、表达式求值、语法高亮、AI 兜底触发条件判断(不依赖 DOM,可以直接被 Node 测试 `require`)
- `app.js` — DOM 绑定:读取输入框、渲染结果、调用后端兜底服务,内部逻辑都委托给 `engine.js`
- `server/` — 可选的兜底后端服务(Node.js + Express),调用通义千问(Qwen)API,供**本地开发**使用
  - `server.js` — Express 服务入口,提供 `/api/evaluate` 和 `/api/health` 两个接口
  - `qwen.js` — 真正的 Qwen 调用逻辑(拼 prompt、解析结果、拉实时汇率等),不依赖 Express,被 `server.js` 和 `api/*.js` 共用
  - `.env` — 存放 `QWEN_API_KEY` 等配置(不要提交到 git)
- `api/` — **Vercel Serverless Function** 版本的同一套接口(`health.js`/`evaluate.js`),部署到 Vercel 后自动生效,逻辑复用 `server/qwen.js`
- `tests/` — 冒烟/回归测试,见下方「测试」一节
- `package.json` — 根目录测试用的依赖(仅 `mathjs`,供 Node 测试环境使用;和浏览器里通过 CDN 加载的是同一个库)

## 解析逻辑简述

每一行会依次经过以下处理,再交给 math.js 求值:

1. 去除 `what is` / `calculate` / 问号等提问语气词
2. 识别整行的聚合表达式(`sum of ...` / `average of ...` / `max of ...` / `min of ...`),提取所有数字后计算
3. 识别整行的一元函数短语(`decimal part of ...`、`square root of ...` 等),转换为对应的 math.js 函数调用(`fix()`、`sqrt()`、`abs()` 等)
4. 将 `X% of Y` / `X percent of Y` 转换为 `(X/100*Y)`
5. 将自然语言运算符(`plus`、`minus`、`times` 等)替换为对应符号
6. 将单独出现的 `X%` 转换为 `(X/100)`
7. 若整行形如 `name = 表达式`,则作为变量赋值传给 math.js 的作用域,供后续行引用

如果某一行无法解析或不包含数字(如纯文字备注),左侧对应结果会留空。

## AI 兜底机制(混合方案)

> 以下流程只在页面顶部的 **AI 兜底开关打开**时才会发生;开关关闭(默认状态)时,页面 100% 离线,只走第 1 步。

1. 每次输入,前端先用本地规则引擎计算所有行,结果**立即**显示(免费、离线、无延迟)
2. 停止输入约 0.7 秒后,前端会检查还有哪些行"本地算不出来、但看起来像是计算"(包含数字,或者引用了已定义的变量名)
3. 对这些行,前端会把**整个笔记内容 + 目标行号**发给本地的兜底服务(`server/server.js`),由它转发给通义千问,请求返回一个纯数字答案
4. 等待期间,左侧该行会显示灰色斜体的 `…`;拿到答案后,会显示**紫色**并带 `✦` 标记的数字,鼠标悬停可以看到"由 AI 兜底计算"的提示,方便你分清哪些答案是确定性引擎算的、哪些是模型猜的
5. 如果模型也判断不出数字(比如纯文字备注),该行会保持留空,不会硬造一个答案

这样做的好处:大部分常见计算走本地引擎(快、免费、稳定),只有规则覆盖不到的"疑难杂句"才会真正花一次 API 调用去问模型,不需要你每次遇到新句式都来找我加正则规则。

**关于调用频率**:打开/刷新页面本身**不会**调用 Qwen API,只会调用 `/api/health` 做免费的在线检测。AI 答案会按"这一行 + 它之前所有行的内容"缓存到浏览器本地存储里,同一段内容只会真正问模型一次——哪怕你刷新页面、关掉重开,只要那一行文字没变,都会直接复用缓存,不会重新花一次调用。只有内容变了(或者是全新的一行)才会真正触发新的 API 请求。

## 结果为空时如何排查

如果连 AI 兜底都留空,通常是以下情况之一:

- **后端服务没启动,或状态灯显示"离线"**:先确认 `cd server && npm start` 是否在运行,页面顶部状态灯应显示"AI 兜底:在线"
- **这行真的没有数学意义**(比如纯文字备注、标题),模型会正确地返回"无法计算"而不是瞎编一个数字
- **变量名拼写或空格与定义时不一致**,比如定义时是 `daily snack cost`,引用时写成 `daily snacks cost`,本地引擎认不出来;不过这种情况通常 AI 兜底能靠语义猜出你的意图

输入区里的语法高亮也能帮助定位问题:本地引擎认识的数字、关键词、变量名都会被上色;某个词一直是默认黑色,说明本地引擎不认识它,但不代表 AI 兜底也算不出来。

## 测试(每次加新功能后跑一遍)

### 1. 自动化测试(离线,不需要后端、不需要 API Key,几百毫秒跑完)

覆盖本地规则引擎(百分比、聚合函数、变量、货币符号、一元函数短语等)和后端 `extractResult` 的 JSON 解析逻辑,以及"是否要触发 AI 兜底"的判断逻辑。

```bash
cd notepad          # 项目根目录
npm install          # 第一次运行前,安装测试用的 mathjs 依赖
npm test
```

新增功能 / 修了 bug 后,建议顺手在 `tests/engine.test.js`(本地规则引擎)、`tests/fallback-heuristic.test.js`(AI 兜底触发条件)或 `tests/server-extract-result.test.js`(后端 JSON 解析)里加一条对应的用例,防止以后回归。

### 2. 后端实时冒烟测试(需要 API Key,会真实调用 Qwen,产生少量费用)

覆盖自动化测试覆盖不到的部分:日期推算、汇率换算、"纯文字备注不应该被瞎编答案"这几类必须真正问模型才能验证的场景。

```bash
cd notepad/server && npm start     # 先启动后端(另开一个终端)
cd notepad && node tests/smoke-backend.js   # 再跑冒烟测试
```

## 后续可扩展方向

- 支持货币/单位换算(math.js 本身已支持单位系统,可进一步接入)
- 支持更多自然语言模式,如"increase X by Y%"、"X off Y"
- 支持多主题(浅色/深色切换)
