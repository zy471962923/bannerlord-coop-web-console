// 抓取 GitHub Releases 作为"更新日志"，落盘到 data/changelog.json
// 用法：node tools/fetch-changelog.js [--quiet]
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'changelog.json');
const API = 'https://api.github.com/repos/Bannerlord-Coop-Team/BannerlordCoop/releases?per_page=10';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'coop-web-console',
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main(opts = {}) {
  const quiet = opts.quiet !== undefined ? opts.quiet : process.argv.includes('--quiet');
  const releases = await get(API);

  const data = {
    source: 'https://github.com/Bannerlord-Coop-Team/BannerlordCoop/releases',
    fetchedAt: new Date().toISOString(),
    releases: releases.map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      url: r.html_url,
      prerelease: !!r.prerelease,
      body: r.body || '',
    })),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');

  if (!quiet) {
    console.log('抓取到 ' + data.releases.length + ' 个版本 -> ' + OUT);
    for (const r of data.releases) {
      console.log('  ' + r.tag + '  ' + (r.publishedAt || '').slice(0, 10) + '  ' + r.name);
    }
  }
  return data;
}

if (require.main === module) {
  main().catch((e) => { console.error('抓取失败: ' + e.message); process.exit(1); });
}

module.exports = { fetchChangelog: main, OUT };
