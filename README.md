# BlinkWord · 翻译小卡片 📇

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2B-blue)](#) [![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](#) [![FSRS](https://img.shields.io/badge/FSRS-5-orange)](https://github.com/open-spaced-repetition/ts-fsrs) [![License](https://img.shields.io/badge/license-MIT-green)](#license)

> **English**: BlinkWord is a Windows desktop app that pops up a Doubao-style mini card when you select text anywhere — translate it or save it in one click. Saved words go into a vocabulary book reviewed with the FSRS spaced-repetition algorithm (the same family Anki uses). Built with Electron; translation via a pluggable service pool (DeepSeek / Microsoft / MyMemory / DeepL / Baidu / Youdao / any OpenAI-compatible endpoint); multi-device sync via a zero-dependency self-hosted server or Jianguoyun WebDAV.

一个 Windows 桌面端的划词翻译 + 背单词应用:**在任意应用里选中文字,自动弹出豆包风格的小卡片**,一键「翻译」或「存储」;存下的词进入单词本,按 **FSRS 记忆算法**(Anki 同款,ts-fsrs 实现)安排复习。

## 界面预览

| 划词弹卡 | 翻译结果 |
|---|---|
| ![划词弹卡](docs/screenshots/popup-pill.png) | ![翻译结果](docs/screenshots/translate-panel.png) |

| 单词本(点卡片展开释义+例句) | 背单词(四选一,词库干扰项) |
|---|---|
| ![单词本](docs/screenshots/wordbook.png) | ![背单词](docs/screenshots/review-quiz.png) |

| 翻译服务池 + 词库 | 账号同步 |
|---|---|
| ![设置](docs/screenshots/settings.png) | ![账号](docs/screenshots/account.png) |

## 为什么做这个

市面上的工具要么只做划词翻译、要么只做背单词,「阅读时随手收词 → 科学复习」的闭环总是断的:

| 工具 | 划词弹卡 | 收词进本 | 科学复习 | 多端同步 |
|---|---|---|---|---|
| pot-desktop / openai-translator | ✅ | ❌ | ❌ | ❌ |
| Anki | ❌ | 需手动制卡 | ✅ | ✅ |
| qwerty-learner | ❌ | 现成词库 | ✅ | ❌ |
| 欧路词典等商业软件 | ✅ | ✅ | ✅ | ✅ 但闭源收费 |
| **BlinkWord** | ✅ 豆包式即弹 | ✅ 一键存词 | ✅ FSRS | ✅ 自建服务器 / WebDAV |

## 功能

### 1. 划词小卡片(参考豆包)
- 在浏览器、Word、微信、PDF 等**任意应用**中:
  - **拖拽选中**文字,或**双击选词**,光标附近**快速弹出**深色胶囊小卡片(先无障碍直读取词、确认有文字才弹卡,主流应用 ~0.16s,不误弹);
  - 点 **翻译**:胶囊展开为结果面板(译文 + 音标 + 词典释义 + 朗读 + 例句);
  - 点 **存储**:立即收进单词本,显示「✓ 已存入」。
- 取词原理:优先系统无障碍接口(UI Automation)直读选区,**不占用剪贴板**;个别不支持的应用退回模拟 `Ctrl+C`(约 1 秒内自动恢复原剪贴板)。
- 也支持热键模式:`选中文字 → 按 Alt+Q`(可在设置里改)。

### 2. 单词本 + 背单词(参考百词斩)
- 单词本:搜索、筛选(待复习/学习中/已掌握)、手动添加、朗读、删除、重置进度;划词存入但没来得及翻译的词,会**自动补全释义**。
- **点开卡片看详情**:点击任意单词卡展开释义列表和例句;例句来自 DeepSeek 等翻译服务(存词时自动带上),老词条可点「获取例句」即时补一条。
- **重要度**:同一个词被重复记录时,重要度 +1——单词卡片挂红色「重要 ×N」徽标,复习队列中优先出队并提前重现。
- 背单词:每日学习量可设(5/10/20/30),两种题型自动切换:
  - **释义四选一**(类似百词斩的选择题;干扰项优先取单词本释义,不足时从下载的词库随机抽取);
  - **翻卡自评**(词库较少时:认识 ✅ / 没记住 ❌)。
- **FSRS 记忆算法**(ts-fsrs,Anki 同款):认识→Good、没记住→Again,按记忆稳定性安排间隔——实测连续答对的复习间隔为 2 → 6 → 17 → 44 → 102 天,答错则约 10 分钟后重现、稳定性大幅回落;旧数据自动折算迁移。"已掌握"口径 = 稳定性 ≥ 21 天。
- **词库(四选一干扰项)**:设置页可下载开源项目 qwerty-learner 的词库(四级/六级/高考/考研/托福/GRE/BEC),仅用作干扰项来源,不进单词本。
- 统计:总词汇 / 待复习 / 学习中 / 已掌握,以及未来 7 天复习安排图表。

### 3. 托盘常驻
关闭主窗口后应用驻留系统托盘(划词功能持续可用);托盘菜单可打开单词本、临时关闭划词、退出。

## 快速开始

```bash
# 方式一:双击 启动.bat
# 方式二:命令行
npm install   # 首次(已配置国内镜像则加 --registry=https://registry.npmmirror.com)
npm start
```

调试弹卡 UI(无需真实划词):`npm run demo`,会在屏幕中央弹出示例卡片 "resilience"。

## 翻译内容从哪里来?(服务池,参考 pot-desktop 的多服务架构)

**设置 → 翻译服务**里可勾选启用、↑↓ 排序、填写 Key,翻译时从上到下依次尝试,第一个成功者生效:

| 服务 | 需 Key | 说明 |
|---|---|---|
| **DeepSeek (LLM)** | API Key | 质量最好、能联系语境,一次返回译文+音标+释义+例句;约 1~2 元/百万 token,翻译有本地缓存,延迟 1~3 秒 |
| 微软 Edge 翻译 | 免 | Edge 浏览器"翻译"同款引擎,快、国内直连,默认主力 |
| MyMemory | 免 | 翻译记忆库,兜底 |
| 自定义 OpenAI 兼容 (LLM) | URL+Key+模型 | 智谱 GLM / Kimi / 通义 / 本地 Ollama 等任何 OpenAI 协议端点 |
| DeepL / 百度 / 有道 / LibreTranslate(自建) | 各自 Key | 按需启用 |

- 英文单词的音标/释义:LLM 服务命中时直接附带;否则回退 dictionaryapi.dev 词典接口(网络不佳可能拿不到);
- 本地缓存:同一个词只请求一次;换服务后可点「清除翻译缓存」;
- 新增服务:在 `src/services/` 加一个模块(导出 id/name/cfgFields/translate)并在 `index.js` 注册即可。

## 账号登录与多端同步

应用内置两种同步方式,**二选一或并存**(并存时最近连接的生效,也可在账号页点「设为当前同步方式」切换):自建同步服务器,或坚果云 WebDAV 网盘。两种方式合并规则相同:按单词去重,释义取非空者,学习进度(记忆稳定性/复习次数)与重要度取两边较大值,不会互相覆盖丢数据。

### 方式一:自建同步服务器(数据完全自持,零依赖)

```bash
# 1. 启动同步服务器(或双击 启动同步服务器.bat)
node server/server.js          # 默认 http://127.0.0.1:7788,PORT 环境变量可改端口

# 2. 应用内「账号」页 → 注册 / 登录 → 自动同步
```

- 登录后,划词存词、复习进度、重要度等任何改动约 5 秒内自动同步;也可在账号页手动「立即同步」;
- **多端同步**:把 `server/` 目录放到一台所有设备都能访问的机器(局域网电脑/NAS/云服务器),各设备在登录框里把服务器地址改成 `http://<那台机器的IP>:7788`,登录同一账号即可;
- 安全:密码 scrypt 加盐散列存储,令牌 HMAC 签名 30 天有效;服务器数据落盘在 `server/data/`(已 gitignore,严禁入库)。公网部署请务必挂 HTTPS 反向代理(如 Nginx + Let's Encrypt)。

### 方式二:坚果云 WebDAV(免自建服务器,数据存在自己的网盘)

词库以单个 JSON 文件(默认 `translate-card/wordbook.json`)存在你的坚果云网盘里,不经过任何第三方服务器:

1. 到坚果云网页端「账户信息 → 安全选项 → 添加应用密码」,生成一个应用密码(不要用登录密码);
2. 应用内「账号」页 → 坚果云 WebDAV 卡片,填账号邮箱 + 应用密码 → 「测试连接」→「保存并连接」;
3. 多台设备填同一账号即可互相同步;同步前先拉取云端与本地合并,再写回,两端只增不覆盖。

- 应用密码用系统级加密(safeStorage/DPAPI)保存在本机,「断开」即清除,也可随时在坚果云后台撤销;
- 写回带 ETag 并发保护:两台设备同时同步时后到的一方会重新拉取合并,不会整文件覆盖;
- 免费版每月上传 1GB:词库文件通常只有几十 KB,且无改动时不上传,额度远够用。

## 技术栈

- **Electron 33**:主进程 + 两个渲染层(主窗口 / 划词弹卡),无前端框架,纯 HTML/CSS/JS,零构建;
- **uiohook-napi**:全局鼠标钩子(划选手势识别);
- **Windows UI Automation**:选区直读取词(不碰剪贴板);
- **ts-fsrs**:FSRS-5 记忆调度算法;
- **同步服务器**:Node 内置 `http` 模块实现,**零第三方依赖**,单文件即可部署。

## 开发与调试

```bash
npm start        # 启动应用
npm run demo     # 演示模式:屏幕中央弹出示例划词卡片
npm test         # WebDAV 同步逻辑自测(mock 服务器)
```

- 划词弹卡是独立透明窗口(`src/renderer/popup/`),可单独改动样式与交互;
- 翻译服务池在 `src/services/`,每个服务一个文件,统一接口 `{ id, name, needsKey, cfgFields, translate(text, cfg) }`;
- 卡片详情、弹卡、账号页等 UI 有 E2E 自检(`CARD_E2E=1` 环境变量),会自动走一遍主流程并输出应用内截图。

## 项目结构

```
src/
├── main.js               # 主进程:窗口、托盘、弹卡生命周期、IPC
├── capture.js            # 全局鼠标钩子 + UIA 直读取词(兜底 Ctrl+C)
├── translate.js          # 翻译调度:服务池取译文 + 词典补充 + 缓存
├── services/             # 翻译服务池(pot 式):edge/mymemory/deepseek/openai兼容/deepl/百度/有道/libre
├── store.js              # 本地存储:单词本 JSON + FSRS 记忆调度 + 设置
├── merge-words.js        # 词库合并规则(与 server/server.js 同一套,WebDAV 同步用)
├── account.js            # 账号登录 / 自建服务器云同步客户端
├── webdav.js             # 坚果云 WebDAV 同步客户端
├── dicts.js              # qwerty-learner 词库下载/缓存(四选一干扰项)
├── preload.js            # contextBridge 暴露的安全 IPC 接口
└── renderer/
    ├── main/             # 主窗口(单词本 / 背单词 / 统计 / 账号 / 设置)
    └── popup/            # 划词小卡片(胶囊 ⇄ 结果面板)
server/
└── server.js             # 零依赖同步服务器(注册/登录/词库合并),数据在 server/data/
test/
└── webdav.test.js        # WebDAV 同步自测(mock 服务器):首次上传/双端合并/冲突重试
docs/screenshots/         # README 截图(由应用内 E2E 自检生成)
```

数据保存在 `%APPDATA%/翻译小卡片/`(词库 `wordbook.json`、账号 `account.json`、坚果云配置 `webdav.json`);设置里可导出/导入 JSON 备份。

## 路线图

- [x] 划词弹卡(翻译 / 存储)
- [x] FSRS 记忆算法 + 四选一题型
- [x] 翻译服务池(LLM / 传统翻译双轨)
- [x] 多端同步(自建服务器 / 坚果云 WebDAV)
- [ ] 官方托管云账号(免自建)
- [ ] 鸿蒙 HarmonyOS 版(方案 A:ArkTS 原生;方案 B:WebView 复用 Web 渲染层,见 `harmony/`)
- [ ] 打包安装程序(electron-builder)与自动更新

## 常见问题

- **杀毒软件提示模拟按键?** 兜底取词依赖系统级 `Ctrl+C` 模拟(与欧路词典等划词工具同原理),属正常行为,放行即可;绝大多数应用走 UIA 直读,不触发此项。
- **某些应用里划词没反应?** 该应用可能不支持 UIA 与复制快捷键(如部分终端/游戏);可改用热键模式,或复制后再按热键。
- **翻译失败?** 检查网络;翻译源在国内可直连,若公司网络有代理限制,可稍后重试(结果有缓存),或在设置里多启用几个服务。
- **双击图标/拖窗口会弹卡吗?** 不会——只有确认取到了文字才弹卡。

## 致谢

- [qwerty-learner](https://github.com/RealKai42/qwerty-learner) — 四选一干扰项词库来源
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) — FSRS 记忆算法实现
- [pot-desktop](https://github.com/pot-app/pot-desktop) — 翻译服务池架构参考
- [豆包](https://www.doubao.com/) — 划词小卡片的交互灵感
- 百词斩 / Anki — 背单词产品形态参考

## License

[MIT](LICENSE) © 2026 piggyham
