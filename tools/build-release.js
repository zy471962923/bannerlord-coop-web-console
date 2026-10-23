'use strict';
// 一键整理「发布包」和「源码仓库」两份产物：
//
//   ..\dist\release\CoopConsole\     可直接双击运行的运行时（含 node.exe 与裁剪过的 node_modules）
//   ..\dist\release\CoopConsole-v<ver>.zip            发布包（约 40MB，一个包搞定）
//   ..\dist\source\                  可 git init / push 的源码目录（.gitignore 已写好）
//
// 用法：
//   node tools/build-release.js              两样都做（默认）
//   node tools/build-release.js --release    只做发布目录
//   node tools/build-release.js --source     只做源码目录
//   node tools/build-release.js --zip        顺便打成 zip
//   node tools/build-release.js --no-node    不内置 node.exe（包会小到 9MB，但对方要自己装 Node）
//   node tools/build-release.js --keep       不先清空目标目录（增量覆盖）
//   node tools/build-release.js --check      只校验现有的发布包
//
// node.exe 来源：默认就用当前跑构建的这个 node（process.execPath），
// 想换成别的版本：set COOP_NODE_EXE=D:\node22\node.exe 再跑。
//
// 为什么 node_modules 要手工裁：
//   node-pty 装完 64MB，其中 prebuilds 58MB —— 一半是 win32-arm64 的二进制（用不上），
//   另一半是 *.pdb 调试符号表（每个 4~6MB，运行时完全不读）。
//   实际运行时只需要 win32-x64 的 3 个 .node + 2 个 exe/dll + conpty\ 子目录。
//   裁剪后 2.9MB，已实测 spawn 正常（node tools/ptyprobe.js 可复核）。
//
// 自检：node tools/build-release.js && node tools/build-release.js --check
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CONSOLE_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(CONSOLE_DIR, '..');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const REL_DIR = path.join(DIST_DIR, 'release');
const REL_APP = path.join(REL_DIR, 'CoopConsole');
const SRC_DIR = path.join(DIST_DIR, 'source');

const PKG = JSON.parse(fs.readFileSync(path.join(CONSOLE_DIR, 'package.json'), 'utf8'));
const VERSION = PKG.version || '1.0.0';
const ZIP_NAME = 'CoopConsole-v' + VERSION + '.zip';

// node.exe：直接打进主包根目录，玩家解压就能双击，不用另下一个包
// （想指定别的版本：set COOP_NODE_EXE=D:\path\node.exe 再跑）
const NODE_EXE = process.env.COOP_NODE_EXE || process.execPath;

const ARGV = process.argv.slice(2);
const has = (n) => ARGV.includes(n);
const onlyRelease = has('--release');
const onlySource = has('--source');
const doRelease = onlyRelease || !onlySource;
const doSource = onlySource || !onlyRelease;
const doZip = has('--zip');
const keep = has('--keep');

// ————————————————————————— 小工具 —————————————————————————

function log(msg) { process.stdout.write(msg + '\n'); }
function hr(t) { log('\n=== ' + t + ' ==='); }

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

// 清空目录内容但保留 .git（源码目录重生成时不能用 rmrf，会把提交历史一起删了）
function rmrfKeepGit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function copyFile(rel, intoDir) {
  const from = path.join(CONSOLE_DIR, rel);
  const to = path.join(intoDir, rel);
  if (!fs.existsSync(from)) { log('  [跳过] 缺文件 ' + rel); return false; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

// 手写递归拷贝。
// 不用 fs.cpSync：本机这个 node 构建上 cpSync 拷目录会直接以退出码 127 静默死掉
// （无异常、无 stderr、无输出），排查代价太大，索性自己走 readdir + copyFileSync。
function copyTree(src, dst, filter) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dst, name), filter);
    }
    return;
  }
  if (filter && !filter(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(rel, intoDir, filter) {
  const from = path.join(CONSOLE_DIR, rel);
  const to = path.join(intoDir, rel);
  if (!fs.existsSync(from)) { log('  [跳过] 缺目录 ' + rel); return false; }
  copyTree(from, to, filter);
  return true;
}

function write(intoDir, rel, content, opts) {
  const to = path.join(intoDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let buf = Buffer.from(content, 'utf8');
  // Windows 记事本对无 BOM 的 UTF-8 老版本会乱码；带 BOM 最保险
  if (opts && opts.bom) buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
  if (opts && opts.crlf) buf = Buffer.from(buf.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
  fs.writeFileSync(to, buf);
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else total += fs.statSync(f).size;
    }
  };
  if (fs.existsSync(p)) walk(p);
  return total;
}
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

// ————————————————————————— 发布目录 —————————————————————————

// 运行时必需（少一个就打不开页面）
const APP_FILES = [
  'server.js',
  'package.json',
  'config.example.json',
  'start-console.bat',
  'start-console-lan.bat',
  'open-firewall.bat',
];
const APP_DIRS = ['lib', 'public'];
// tools\fetch-changelog.js 是 server.js 里 require 进来的（"更新日志"页刷新按钮），必须带
const TOOL_FILES = ['tools/fetch-changelog.js'];
// 首次启动就有命令表和更新日志，不用等联网
const DATA_FILES = ['data/commands.json', 'data/changelog.json'];

// node-pty 运行时最小集：lib\ + 本平台二进制
const PTY_FILES = ['node_modules/node-pty/package.json', 'node_modules/node-pty/LICENSE'];
const PTY_DIRS = ['node_modules/node-pty/lib'];
const PTY_BIN = [
  'pty.node',
  'conpty.node',
  'conpty_console_list.node',
  'winpty-agent.exe',
  'winpty.dll',
];

function buildRelease() {
  hr('发布目录 → ' + REL_APP);
  if (!keep) rmrf(REL_APP);
  fs.mkdirSync(REL_APP, { recursive: true });

  let n = 0;
  for (const f of APP_FILES) if (copyFile(f, REL_APP)) n++;
  for (const d of APP_DIRS) if (copyDir(d, REL_APP)) n++;
  for (const f of TOOL_FILES) if (copyFile(f, REL_APP)) n++;
  for (const f of DATA_FILES) if (copyFile(f, REL_APP)) n++;

  // 手册 PDF（如果有，名字带中文也照拷）
  const docsFrom = path.join(CONSOLE_DIR, 'docs');
  if (fs.existsSync(docsFrom)) {
    for (const f of fs.readdirSync(docsFrom)) {
      if (/\.pdf$/i.test(f)) {
        fs.mkdirSync(path.join(REL_APP, 'docs'), { recursive: true });
        fs.copyFileSync(path.join(docsFrom, f), path.join(REL_APP, 'docs', f));
        log('  + docs/' + f);
        n++;
      }
    }
  }

  // 裁剪版 node_modules
  const pty = path.join(CONSOLE_DIR, 'node_modules', 'node-pty');
  if (!fs.existsSync(pty)) {
    log('  [警告] 本机没装 node-pty，发布包里将缺少运行时依赖！先跑 npm install。');
  } else {
    for (const f of PTY_FILES) if (copyFile(f, REL_APP)) n++;
    for (const d of PTY_DIRS) if (copyDir(d, REL_APP)) n++;
    const binDir = path.join(pty, 'prebuilds', 'win32-x64');
    const dstBin = path.join(REL_APP, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64');
    fs.mkdirSync(dstBin, { recursive: true });
    for (const f of PTY_BIN) {
      const from = path.join(binDir, f);
      if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(dstBin, f)); }
      else log('  [警告] node-pty 缺少 ' + f);
    }
    // conpty\ 里是 OpenConsole.exe + conpty.dll，ConPTY 模式要靠它
    const conptyDir = path.join(binDir, 'conpty');
    if (fs.existsSync(conptyDir)) {
      copyTree(conptyDir, path.join(dstBin, 'conpty'));
    }
    log('  + node_modules/node-pty（精简版）');
    n++;
  }

  // 说明文件
  write(REL_APP, 'INSTALL.txt', installText(), { bom: true, crlf: true });
  write(REL_APP, 'QUICKSTART.txt', quickstartText(), { bom: true, crlf: true });
  write(REL_APP, 'LICENSE', licenseText(), { crlf: true });
  write(REL_APP, 'README.md', releaseReadme(), { crlf: true });
  // 空目录占位：data\ 在，第一次跑就不会因为目录不存在报错
  fs.mkdirSync(path.join(REL_APP, 'data'), { recursive: true });

  log('  共 ' + n + ' 项，体积 ' + mb(dirSize(REL_APP)));
}

// 给玩家看的安装说明。bat 里不敢写中文（多字节会被 cmd 拆开），
// 所以找不到 node.exe 时 bat 会直接 start notepad 打开这个文件。
function installText() {
  return [
    'Bannerlord Coop 服务器网页控制台 —— 安装说明',
    '================================================',
    '',
    '解压就能用，不需要安装任何东西。',
    '',
    '',
    '━━ 第一步：解压 ━━',
    '',
    '把压缩包整个解压到任意一个文件夹，比如 D:\\CoopConsole。',
    '',
    '    D:\\CoopConsole\\',
    '        start-console.bat     <= 双击这个',
    '        node.exe              运行环境，已经放好了，不用管',
    '        server.js',
    '        lib\\',
    '        docs\\',
    '        ...',
    '',
    '不要只把 start-console.bat 单独拖出来，要整个文件夹一起用。',
    '',
    '',
    '━━ 第二步：启动 ━━',
    '',
    '双击 start-console.bat。',
    '',
    '窗口里出现这两行就说明起来了：',
    '',
    '    [node]  D:\\CoopConsole\\node.exe',
    '    本机打开  : http://127.0.0.1:7788/',
    '',
    '浏览器打开这个地址就能看到面板。',
    '',
    '窗口不要关 —— 服务端就跑在这个窗口里，关掉窗口服务器就停了。',
    '',
    '',
    '━━ 第三步：第一次用先填两个路径 ━━',
    '',
    '打开页面 → 顶上「配置」→ 第一张卡片里填两行：',
    '',
    '    服务端目录    填「含 DedicatedServer 文件夹的那一层」',
    '                  例如  D:\\BannerlordCoopServer',
    '',
    '    存档目录      一般是  文档\\Mount and Blade II Bannerlord\\CoopData',
    '',
    '保存 → 关掉窗口重新打开。',
    '',
    '填错了卡片下面会标红，告诉你哪一行不对。',
    '',
    '',
    '━━ 常见问题 ━━',
    '',
    '· 双击 bat 一闪就没了',
    '    → 文件夹没解压完整。重新解压一次，注意要整个文件夹一起解压，',
    '      别只拖 start-console.bat 出来。',
    '',
    '· 窗口里说端口被占用',
    '    → 已经有一个控制台在跑了。想再开一个只读面板：',
    '      start-console.bat 7790      （换一个端口）',
    '',
    '· 别的电脑打不开',
    '    → 用 start-console-lan.bat 启动；',
    '      再右键 open-firewall.bat → 以管理员身份运行，放行一下端口。',
    '',
    '· 想看详细说明',
    '    → docs 文件夹里的 PDF 手册，12 章带截图。',
    '',
  ].join('\n');
}

function quickstartText() {
  return [
    'Bannerlord Coop 服务器 Web 控制台 v' + VERSION + '  ——  快速上手',
    '================================================================',
    '',
    '【一、解压】',
    '  把压缩包整个解压到一个文件夹（例如 D:\\CoopConsole），然后双击 start-console.bat。',
    '  运行环境 node.exe 已经在包里放好了，不用装任何东西。',
    '',
    '  注意整个文件夹要一起用，不要只把 start-console.bat 单独拖出来。',
    '',
    '【二、启动】',
    '  双击 start-console.bat',
    '  看到  [console] http://0.0.0.0:7788  字样后，浏览器打开：',
    '',
    '      http://127.0.0.1:7788',
    '',
    '  同机器以外（局域网 / ZeroTier）用本机 IP 访问同一个端口。',
    '  只想本机可见：双击 start-console-lan.bat 不行，要 start-console.bat local',
    '  想换端口：    start-console.bat 7790',
    '',
    '  ⚠ 服务端跑在控制台的伪终端里 —— 关掉控制台窗口，游戏服务器会一起停。',
    '    想长期挂机就照旧用 start-server.bat 起服，控制台当只读面板用',
    '    （顶栏会标"外部实例"，能看日志/能强制结束，但下发不了命令）。',
    '',
    '【三、第一次用必须先改配置】',
    '  打开页面 →「配置」标签 → 最上面那张卡片 →',
    '    服务端安装目录  填 含 DedicatedServer 子目录的那层，例如 D:\\BannerlordCoopServer',
    '    存档目录        填 文档\\Mount and Blade II Bannerlord\\CoopData',
    '  保存 → 重启控制台。',
    '',
    '  卡片下方会实时提示哪一项路径不存在，红字就是问题所在。',
    '  保存的是本目录下的 config.json（本包不带 config.json，第一次是自动探测）。',
    '',
    '【四、端口和防火墙】',
    '  控制台端口默认 7788（TCP），游戏端口默认 4200（UDP）。',
    '  别人连不进来先跑一次 open-firewall.bat（要管理员权限）：',
    '',
    '      open-firewall.bat            用默认 7788 / 4200',
    '      open-firewall.bat 7790 4200  控制台换过端口就这样传',
    '',
    '【五、完整说明】',
    '  docs\\ 目录里是《使用手册》PDF，从安装到每个标签页都有截图，',
    '  遇到问题先翻它；还解决不了，按手册最后一页的三样材料反馈。',
    '',
    '【六、免责】',
    '  这是外挂式运维面板，不含游戏本体、不修改游戏内存、不注入进程。',
    '  但能执行作弊/踢人/关服命令 —— 给谁用、给多大权限，请自己把关。',
    '  重要存档请先手动备份。因使用本工具造成的任何损失，作者不承担责任。',
    '',
    '                                    本控制台可自由转载、二次分发，请保留致谢。',
    '',
  ].join('\n');
}

function licenseText() {
  return [
    'MIT License',
    '',
    'Copyright (c) 2026 张宇 (Corvus.Jazz)',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '',
    '--------------------------------------------------------------------',
    '第三方组件与素材（Third-party notices）',
    '--------------------------------------------------------------------',
    'node-pty            Microsoft, MIT License      伪终端（ConPTY）绑定',
    'Bannerlord Coop     Bannerlord-Coop-Team        联机模组与专用服务器，本工具不包含其代码',
    'Mount & Blade II    TaleWorlds Entertainment    游戏本体，本工具不包含任何游戏资源',
    'Calradia 底图       Map by Vesper, "Calradia 1084", TaleWorlds 官方论坛',
    '中文译名            取自官方简体中文语言包',
    '',
  ].join('\n');
}

function releaseReadme() {
  return [
    '# Bannerlord Coop 服务器 Web 控制台 v' + VERSION,
    '',
    'Bannerlord Coop 专用服务器的浏览器运维面板：实时日志、TUI 镜像、玩家档案、',
    '全图玩家位置、命令台、存档备份、更新日志。零前端框架、零构建步骤，',
    '唯一外部依赖 node-pty（已随包提供，无需 npm install）。',
    '',
    '## 三步跑起来',
    '',
    '1. 解压到任意文件夹（例如 `D:\\CoopConsole`），**整个文件夹一起用**',
    '2. 双击 `start-console.bat`',
    '3. 浏览器打开 <http://127.0.0.1:7788>',
    '',
    '不用装 Node.js、不用 npm install —— `node.exe` 和依赖都在包里。',
    '详细步骤见 `INSTALL.txt`，完整手册见 `docs/` 里的 PDF（带全部界面截图）。',
    '',
    '## 命令',
    '',
    '```bat',
    'start-console.bat                :: 监听 0.0.0.0:7788（所有网卡）',
    'start-console.bat local          :: 只本机 127.0.0.1',
    'start-console-lan.bat            :: 局域网 / ZeroTier 可访问',
    'start-console.bat 7790           :: 换端口（开副面板用）',
    'open-firewall.bat                :: 放行 7788/TCP + 4200/UDP（需管理员）',
    '```',
    '',
    '端口与监听地址也可以在页面的「配置」标签里改，保存后重启控制台生效。',
    '',
    '## 目录',
    '',
    '```',
    'CoopConsole\\',
    '  node.exe               运行环境（绿色版，解压即用）',
    '  server.js              HTTP 服务 + 路由',
    '  lib\\                   配置探测、PTY 进程、日志跟随、玩家/存档/地图解析',
    '  public\\                前端（原生 JS，无构建）',
    '  data\\                  命令表、更新日志缓存（运行时还会写入 tui.raw 等）',
    '  tools\\fetch-changelog.js  「更新日志」页刷新用',
    '  docs\\                  使用手册 PDF',
    '  node_modules\\node-pty  精简版（只有 win32-x64 运行时，2.9MB）',
    '  config.example.json    配置示例；实际生效的是 config.json（首次运行自动探测）',
    '```',
    '',
    '## 注意',
    '',
    '- 服务端跑在控制台的伪终端里，**关掉控制台窗口游戏服务器会一起停**。',
    '- 包里的 `node.exe` 与依赖都只有 Windows 64 位版，其它平台跑不了（要用请自己 `npm install`）。',
    '- 重要存档请先备份。本工具能执行踢人/关服/作弊命令，给谁用请自己把关。',
    '',
    '本控制台可自由转载、二次修改与分发，请保留 `docs` 里的致谢。',
    '',
  ].join('\n');
}

// ————————————————————————— 源码目录 —————————————————————————

const SRC_FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'config.example.json',
  'start-console.bat',
  'start-console-lan.bat',
  'open-firewall.bat',
  'README.md',
];
const SRC_DIRS = ['lib', 'public', 'tools', '.github'];
// 手册源文件与截图进仓库（PDF 是生成物，不进）
const SRC_DOCS = ['docs/manual.html'];

function buildSource() {
  hr('源码目录 → ' + SRC_DIR);
  // 只清内容，.git 要留着 —— 否则每重跑一次就把提交历史抹了
  if (!keep) rmrfKeepGit(SRC_DIR);
  fs.mkdirSync(SRC_DIR, { recursive: true });

  let n = 0;
  for (const f of SRC_FILES) if (copyFile(f, SRC_DIR)) n++;
  for (const d of SRC_DIRS) if (copyDir(d, SRC_DIR)) n++;
  for (const f of SRC_DOCS) if (copyFile(f, SRC_DIR)) n++;
  // 截图：手册里引用的那 8 张
  if (copyDir('docs/shots', SRC_DIR, (src) => !/\.(psd|bak|tmp)$/i.test(src))) n++;

  write(SRC_DIR, 'LICENSE', licenseText(), { crlf: true });
  write(SRC_DIR, '.gitignore', gitignoreText(), { crlf: true });
  write(SRC_DIR, '.gitattributes', gitattributesText(), { crlf: true });
  write(SRC_DIR, 'data/.gitkeep', '');

  log('  共 ' + n + ' 项，体积 ' + mb(dirSize(SRC_DIR)));
}

// .bat 必须保持 CRLF —— cmd.exe 读 LF-only 的 bat 会在 if(...) 块里错行，
// 双击窗口一闪就关。别的平台 clone 下来也不会被 autocrlf 改成 LF。
function gitattributesText() {
  return [
    '* text=auto',
    '*.bat text eol=crlf',
    '*.cmd text eol=crlf',
    '*.txt text eol=crlf',
    '*.png binary',
    '*.jpg binary',
    '*.pdf binary',
    '',
  ].join('\n');
}

function gitignoreText() {
  return [
    '# —— 依赖 ——',
    'node_modules/',
    '',
    '# —— 本机配置（含绝对路径，别提交）——',
    'config.json',
    '',
    '# —— 运行时产物 ——',
    'logs/',
    'backups/',
    'data/*',
    '!data/.gitkeep',
    '',
    '# —— 生成物 ——',
    'docs/*.pdf',
    'preview/',
    'dist/',
    '',
    '# —— 系统 / 编辑器 ——',
    'Thumbs.db',
    'desktop.ini',
    '.DS_Store',
    '.vscode/',
    '.idea/',
    '*.log',
    '',
  ].join('\n');
}

// ————————————————————————— 校验 / 打包 —————————————————————————

function checkFiles() {
  hr('校验发布包');
  const need = [
    'node.exe',
    'server.js',
    'package.json',
    'lib/config.js',
    'lib/console-config.js',
    'lib/players.js',
    'public/index.html',
    'public/app.js',
    'public/style.css',
    'public/img/calradia.jpg',
    'tools/fetch-changelog.js',
    'node_modules/node-pty/lib/index.js',
    'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
    'INSTALL.txt',
    'QUICKSTART.txt',
    'LICENSE',
  ];
  let bad = 0;
  for (const f of need) {
    const ok = fs.existsSync(path.join(REL_APP, f));
    log('  ' + (ok ? '[OK]  ' : '[缺失] ') + f);
    if (!ok) bad++;
  }
  return bad;
}

// 真跑一次 spawn，确认裁过的 node-pty 能用（不是只检查文件在不在）。
//
// 为什么绕这么一圈（子进程 + 结果写文件 + stdio 全丢）：
//   node-pty 在 pty 退出后会 fork 一个 conpty_console_list_agent 去枚举控制台进程，
//   这时控制台已经没了，它会报 "AttachConsole failed" 并把整段堆栈喷到 stderr；
//   而且那个 fork 会继承父进程的 stdout 管道，让 spawnSync 永远等不到管道关闭（ETIMEDOUT）。
//   所以让子进程把结果写到临时文件，stdio 全部忽略，父进程读文件。
function checkPty() {
  const ptyPath = path.join(REL_APP, 'node_modules', 'node-pty');
  const outFile = path.join(REL_DIR, '.ptyprobe.json');
  // 优先用包里那个 node.exe 跑，这样验的是「玩家拿到的运行时 + 玩家拿到的 node-pty」
  const bundled = path.join(REL_APP, 'node.exe');
  const runner = fs.existsSync(bundled) ? bundled : process.execPath;
  rmrf(outFile);
  const script = [
    'const fs = require("fs");',
    'const pty = require(' + JSON.stringify(ptyPath) + ');',
    'function done(o) { try { fs.writeFileSync(' + JSON.stringify(outFile) + ', JSON.stringify(o)); } catch (_) {} process.exit(o.hit ? 0 : 1); }',
    'const p = pty.spawn("cmd.exe", ["/c", "echo BUILD_PTY_OK"], { cols: 60, rows: 20, useConpty: true });',
    'let out = "";',
    'p.onData(function (d) { out += d; });',
    'p.onExit(function (r) { done({ exitCode: r.exitCode, hit: out.indexOf("BUILD_PTY_OK") >= 0 }); });',
    'setTimeout(function () { done({ exitCode: -1, hit: false, timeout: true }); }, 12000);',
  ].join('\n');
  try {
    execFileSync(runner, ['-e', script], {
      timeout: 20000,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (e) {
    // 子进程以非 0 退出是正常的「探测失败」，结果文件里才有细节
  }
  let r = null;
  try { r = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) {}
  rmrf(outFile);
  if (!r) { log('  [失败] node-pty spawn 没有返回结果'); return false; }
  const ok = r.exitCode === 0 && r.hit;
  log('  ' + (ok ? '[OK]  ' : '[失败] ') + 'node-pty spawn（' +
    (runner === bundled ? '包内 node.exe' : '构建用 node') + '） exit=' + r.exitCode +
    (r.timeout ? ' 超时' : ''));
  return ok;
}

function check() {
  const bad = checkFiles();
  const ptyOk = checkPty();
  const ok = bad === 0 && ptyOk;
  log(ok ? '\n发布包校验通过。' : '\n发布包有问题，先修再打包。');
  return ok;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 压缩时会撞上「文件正由另一进程使用」：刚 exec 过的 exe、或者杀软正在扫刚拷出来的大文件，
// Windows 都可能短暂占着句柄。重试几次比抛错好。
function psCompress(srcPath, zipPath, tries) {
  const max = tries || 4;
  for (let i = 1; i <= max; i++) {
    rmrf(zipPath);
    // Compress-Archive 比 tar -a 稳，且能正确写 UTF-8 文件名标记（中文名解压不乱码）
    const ps = [
      '$ErrorActionPreference="Stop";',
      'Compress-Archive -Path "' + srcPath + '" -DestinationPath "' + zipPath + '" -CompressionLevel Optimal',
    ].join(' ');
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
      return;
    } catch (e) {
      if (i === max) throw e;
      log('  [重试 ' + i + '/' + (max - 1) + '] 文件被占用，等 1.5 秒...');
      sleepSync(1500);
    }
  }
}

function makeZip() {
  hr('打包 ' + ZIP_NAME);
  const zipPath = path.join(REL_DIR, ZIP_NAME);
  psCompress(REL_APP, zipPath);
  log('  ' + zipPath);
  log('  ' + mb(fs.statSync(zipPath).size));
}

// 把 node.exe 直接放进主包根目录（跟 start-console.bat 并排）。
//
// 一开始是拆成「第一步」单独一个包的，后来用户明确要求合并：
// 玩家不懂这些，多一个包就多一步「放到哪」的困惑，宁可包大一点。
// start-console.bat 第一顺位就是找 %~dp0node.exe，所以放根目录即可，不用改脚本。
function copyNodeInto(targetDir) {
  hr('内置 node 运行时');
  if (!fs.existsSync(NODE_EXE)) {
    log('  [警告] 找不到 ' + NODE_EXE + '，包内将不自带 node.exe。可用 COOP_NODE_EXE 指定。');
    return false;
  }

  // 先验源文件能跑，再拷 —— 反过来（先拷再跑拷贝）会让 Windows 锁住目标文件，压缩时报占用
  let ver = '';
  try {
    ver = execFileSync(NODE_EXE, ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    log('  [失败] 这个 node.exe 跑不起来：' + e.message);
    return false;
  }

  const dst = path.join(targetDir, 'node.exe');
  const srcSize = fs.statSync(NODE_EXE).size;
  let dstSize = 0;
  try { dstSize = fs.statSync(dst).size; } catch (_) {}
  if (dstSize === srcSize) {
    log('  node.exe ' + ver + ' 已在位（' + mb(srcSize) + '），跳过拷贝');
  } else {
    rmrf(dst);
    copyTree(NODE_EXE, dst);
    log('  node.exe ' + ver + ' → 包内根目录（' + mb(srcSize) + '）');
  }
  return true;
}

// ————————————————————————— 主流程 —————————————————————————

async function main() {
  log('控制台目录 : ' + CONSOLE_DIR);
  log('产物根目录 : ' + DIST_DIR);
  log('版本       : v' + VERSION);

  if (doRelease) {
    buildRelease();                              // 会先清空 REL_APP，所以 node.exe 必须在它之后再放
    if (!has('--no-node')) copyNodeInto(REL_APP);
    const ok = check();
    if (!ok) { process.exitCode = 1; return; }
    if (doZip) makeZip();
    log('\n发布包：' + REL_APP);
  }
  if (doSource) {
    buildSource();
    log('源码仓库：' + SRC_DIR);
  }
}

if (has('--check')) {
  if (!check()) process.exitCode = 1;
} else {
  main().catch((e) => { log('\n[出错] ' + e.stack); process.exitCode = 1; });
}
