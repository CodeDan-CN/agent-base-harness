# Mobile 首版

手机只连接远程 Runtime，不内置、启动或管理 Runtime、Node、Python、SQLite 或 MCP。生产默认启动、Web 构建和 Desktop 打包不包含手机工程。

## 范围与 UI

沿用之前的 OLED 黑色界面讨论：单一聊天页，顶部会话抽屉与新建按钮，底部圆角输入栏。没有“聊天/工作”双标签，没有模型、智能体、Skill、MCP、统计、思考程度和权限预设管理入口。

已接入服务器地址、本地注册/登录、当前账号会话列表、新建/切换/重命名/归档、Markdown、流式回复、停止、排队/补充、必要追问与权限审批、退出登录。保留底层会话/事件/审批语义，不另建手机专用 Runtime。

新会话沿用当前或默认智能体的服务器配置。首页智能体、模型与工具需提前在 Web/桌面端设置。手机支持本地注册，账号与 bcrypt 密码摘要持久保存在本机；注册仅填写账号和密码，内部标识自动生成且不展示，不提供手动关联功能。已有本地账号继续使用原数据。登录引用仅在连接实例内存中保存，关闭进程后重新登录。切换服务器关闭订阅并清除本地登录，不向 Runtime 发送密码或注销请求。

## 工程

- `src/main.tsx`：连接入口，视觉视口/键盘适配。
- `src/mobile.css`：手机布局和纯黑主题。
- `src/mobile-client.ts`：共享 SDK 到 UI API 的适配，客户端身份 `mobile`。
- `src/native-transport.ts`：原生 HTTP 到 streaming fetch 的适配，不等待整个 SSE 结束才返回。
- `android/`：Java Android Activity 与原生网络层。APK 打包本地 `dist/mobile` 资源，不加载服务器返回的 HTML。
- `packages/app-ui`：复用 App 的真实事件控制逻辑、ChatArea、InputArea、审批和追问组件；显式 mobile 变体替换布局，桌面入口默认行为不变。

这是一套 React 手机界面 + Android WebView 壳，不是 React Native，也不是简单打开桌面 Web 地址。使用 [Android WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content) 加载 APK 内资源；禁止任意网络页面、iframe 和本地文件进入带原生接口的 WebView。点击外部 HTTP(S) 链接交给系统浏览器。

原生网络层只允许当前手动选择的服务器及健康检查/查询/命令/SSE 白名单路径，不跟随重定向、不跳过证书验证。公网要求 HTTPS；HTTP 只允许明确的 RFC1918 私有 IPv4 地址（包括模拟器访问开发电脑的 10.0.2.2）。Gateway 同源/CORS 规则没有放宽。

## 开发与构建

```bash
# 仅手机 UI 预览；代理到一个已运行的 Runtime，不启动 Runtime。
AGENT_HARNESS_SERVER_URL=https://your-runtime.example.com npm run dev:mobile
# 电脑浏览器 http://localhost:5175，用设备尺寸预览。

# 仅构建将被装进 APK 的静态资源
npm run build:mobile

# Android 开发签名 APK，需要 Android 工具链
npm run pack:mobile

# Java 地址/权限边界、TypeScript 流式桥测试、真实 Runtime 的浏览器端到端测试
npm run build:server
npm run verify:mobile
```

Android 工具链：JDK 17、Gradle 8.9、Android SDK Platform 35/Build Tools 34.0.0，设置 `ANDROID_HOME`；`AGENT_ANDROID_GRADLE` 可以指定 Gradle 可执行文件。AGP 固定 8.7.3，最低 Android 8.0（API 26），target/compile SDK 35；[官方 AGP 8.7 兼容表](https://developer.android.com/build/releases/agp-8-7-0-release-notes)。Gradle 不随仓库下载或安装，可用 Android Studio 配置同等工具链。

产物路径为 `release/mobile/agent-harness-mobile-debug.apk`；这是开发签名包，不是正式发行签名。部署 Runtime 需要包含新增的 `mobile` 客户端类型。

## 验证与待办

已验证 Java URL/接口白名单、流式 fetch 的 UTF-8 分块/取消/204/并发隔离；真实独立 Runtime 下登录、共享会话、流式回复、停止、新建/重命名/归档、前台恢复、断开连接后 Runtime 存活；360×800、384×854、393×873、412×915、横屏和键盘高度模拟。测试仅使用临时账号/数据和脚本化模型 Provider，不调用付费模型。

当前环境未配置 Android SDK/Gradle，未生成或安装 APK，Activity/原生 HTTP 桥尚未经过 Android 编译和真机验证。浏览器测试不替代 Android 验收。

首版暂不支持附件、语音、产物下载、推送、后台常驻或安全持久令牌。产物按钮会明确提示去 Web/桌面端下载。需继续验收 Android 返回键、真实输入法/安全区、旋转、证书、网络切换、长时间后台与进程回收；前台恢复使用服务器快照和 SSE 游标补齐，不承诺系统后台持续收流。系统 Android WebView 需更新到支持本工程现代浏览器 API 的版本。
