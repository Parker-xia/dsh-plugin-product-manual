# dsh-plugin-product-manual · 产品功能手册生成器

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（Cordis 插件体系）用的**产品访谈插件**：
> 通过多轮对话把普通人脑中的模糊产品想法，整理成一份结构化《产品功能手册》——Markdown + PDF，
> 外加一张截图就能转发的「一页纸」简介。

## 它能做什么

- **访谈协议**：注入「产品访谈员」系统提示——每轮只问 1-2 个用户视角的问题（谁用/什么场景/输入/输出/怎样算成功），
  **绝不主动问技术栈**；能用选项覆盖的问题优先给选项让用户点选。
- **8 章手册**：产品定位 / 目标用户 / 使用场景 / 功能清单（P0-P2）/ 功能需求详述 / 非功能要求 /
  明确不做 / **技术路线（由功能需求倒推）**——前七章不出现技术选型。
- **同类产品检索**：`manual_research` 优先用宿主 `ctx.web` 搜索（覆盖 微信/知乎/网页），
  **并内置 GitHub API 检索兜底**（无需任何宿主服务、无需 key；带 `GITHUB_TOKEN` 环境变量可提额），
  把「别人怎么做」讲给用户听，结果进手册附录「参考案例」。
- **完整手册 PDF**：Markdown → HTML → 本机 Edge 无头打印，文件名直接用产品名（如 `中学校友小程序.pdf`）。
- **一页纸 PDF**：6 个亮点卡片（自动配图标）+ 三步上手 + 适合谁，A4 单页，正向文案、适合截图转发。
- **反馈迭代**：`manual_feedback` 记录读者意见进附录；据此更新章节/一页纸文案后重新生成。

## 安装到 DSH（本部署实测有效的方法）

DSH 的 Web profile 在 `~/.dsh/profiles/web/`，它的本地插件标准位置是 `plugins/<包名>/`，
再在 `cordis.patch.yml` 的 `insert` 列表里加一行（宿主组合，所有会话全局可用）。

### 1. 放置插件包

```bash
# 把本包拷到 profile 的 plugins 目录
cp -r . ~/.dsh/profiles/web/plugins/dsh-plugin-product-manual
# 包入口保持 index.js（本包的 lib/index.js 即入口，复制后重命名为 index.js）
```

目录里至少要有：`index.js`、`package.json`（`"type":"module"`、`"main":"index.js"`）。

### 2. 在 patch 里加一行

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: product-manual
      name: './plugins/dsh-plugin-product-manual/index.js'
```

### 3. 重启 DSH

patch 在启动时读取，重启后插件行生效：所有会话都会出现
`manual_start` / `manual_update` / `manual_research` / `manual_onepager` / `manual_feedback` / `manual_status` / `manual_render`。

> 其它安装方式：
> - **作为 npm 包**：在 `~/.dsh/profiles/web/` 里 `npm install dsh-plugin-product-manual`（或 `pnpm add`），
>   然后 patch 行写成裸包名 `name: dsh-plugin-product-manual`（裸名从 profile 目录解析）。
> - **绝对路径行**：`name: E:\path\to\lib\index.js`（加载器会把绝对路径转成 file URL）。

## 使用

对 agent 说：

> 我想做个「中学校友小程序」，帮我把产品功能手册写出来。

agent 按访谈协议逐轮提问；随时可以说「看看别人怎么做的」触发检索；
最后生成完整手册与一页纸 PDF，交付文件路径和可点击的 PDF 链接。

## 数据布局（工作区）

```
product-manuals/
├── .current.json                 # 当前手册指针（重启后自动恢复）
└── <manual-id>/
    ├── state.json                # 8 章内容、参考案例、改进意见
    ├── <产品名>.md / .pdf        # 完整手册
    └── <产品名>-一页纸.pdf        # 一页纸
```

## 发布到 GitHub

```bash
git init && git add -A
git commit -m "feat: 产品功能手册生成器插件"
git remote add origin https://github.com/<你>/dsh-plugin-product-manual.git
git push -u origin main
```

发布到 npm（别人就能 `npm i` 安装）：

```bash
npm publish
```

## 已知边界 / 运行依赖

- **搜索**：
  - 首选宿主 `ctx.web` 搜索服务（本部署为 DeepSeek 搜索；覆盖 微信小程序案例 / 知乎 / 网页）；
  - **GitHub 方向自带兜底**：插件内部直接调 GitHub REST API（`api.github.com/search/repositories`），
    不依赖任何宿主服务，未认证限速 10 次/分钟；设置 `GITHUB_TOKEN` 环境变量可提额；
  - 宿主没有 web 搜索 provider 时，非 github 方向会返回明确提示（建议改用 `sources:["github"]`）。
- **PDF**：
  - 插件自身完成 Markdown→HTML 转换，再调本机 Chromium 系浏览器无头 `--print-to-pdf`；
  - 浏览器查找顺序：`DSH_PDF_BROWSER`/`DSH_CHROME`/`CHROME_PATH` 环境变量 → 常见 Windows/macOS/Linux 安装路径 → PATH 中的 `msedge`/`chrome`/`chromium`；
  - 进程启动优先用宿主 `subprocess` 服务，缺失时退回 `node:child_process`；
  - 找不到浏览器时仍会输出 Markdown，并在结果 `warnings` 里说明。
- **宿主端插件（host-only）**：不含 Run 卡片里的客户端面板。客户端 UI 需要 `dsh.client` 打包产物，
  且只由宿主组合的 loader entry 扫描；本包是纯宿主插件，面板请在动态版源码存档
  （工作区 `plugins/product-manual/`）中查看。
- PDF 路由前缀按插件实例随机（`/product-manuals-<rand>`），多会话/多实例不冲突。
- 工具参数由插件自身校验（不走 `defineTool` 的自动校验）；返回输出不强制 schema。

## 冒烟测试

```bash
node test-research.mjs
```

用假上下文加载插件，验证：7 个工具注册、`manual_start` 建手册、**无 web 服务时 GitHub 兜底检索**、状态回读。

