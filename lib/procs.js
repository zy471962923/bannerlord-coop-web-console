'use strict';
// Windows 进程/端口侦测：判断服务器是否已经跑起来了（无论是不是本控制台启动的）
const { execFile } = require('child_process');

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

let cache = { at: 0, value: null };
const TTL = 2500;

// 返回 { bound, pid, name } —— bound 表示 UDP 游戏端口已被占用
async function probeGamePort(port) {
  const now = Date.now();
  if (cache.value && now - cache.at < TTL) return cache.value;

  const result = { bound: false, pid: 0, name: '' };

  // UDP：netstat 的 UDP 段没有状态列，匹配 ":4200 "
  const udp = await run('netstat', ['-ano', '-p', 'UDP']);
  for (const line of udp.split(/\r?\n/)) {
    if (!/UDP/i.test(line)) continue;
    if (!new RegExp(':' + port + '\\s').test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[cols.length - 1]);
    if (pid > 0) {
      result.bound = true;
      result.pid = pid;
      break;
    }
  }

  if (result.pid) {
    const tl = await run('tasklist', ['/FI', 'PID eq ' + result.pid, '/FO', 'CSV', '/NH']);
    const m = tl.match(/^"([^"]+)","(\d+)"/m);
    if (m) result.name = m[1];
  }

  // 进程名兜底：有时端口尚未绑定，但进程已在启动中
  if (!result.bound) {
    const tl = await run('tasklist', ['/FI', 'IMAGENAME eq BannerlordCoopServer.exe', '/FO', 'CSV', '/NH']);
    const m = tl.match(/^"([^"]+)","(\d+)"/m);
    if (m) {
      result.bound = true;
      result.pid = Number(m[2]);
      result.name = m[1];
      result.hint = 'process';
    }
  }

  cache = { at: now, value: result };
  return result;
}

function invalidate() { cache = { at: 0, value: null }; }

// 按 PID 强杀整棵进程树（服务端是 launcher + dotnet 子进程）
async function killTree(pid) {
  if (!pid) return false;
  await run('taskkill', ['/PID', String(pid), '/T', '/F'], 15000);
  invalidate();
  return true;
}

module.exports = { probeGamePort, invalidate, killTree, run };
