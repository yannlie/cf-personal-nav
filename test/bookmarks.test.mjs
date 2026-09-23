// bookmarks.js 的单元测试：node --test test/bookmarks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBookmarkHtml, toNetscapeHtml, toJson, parseJson } from '../public/js/bookmarks.js';

// 造一个浏览器风格的导出文件骨架。
function wrap(inner, folder = '') {
  const head = folder ? `    <DT><H3>${folder}</H3>\n    <DL><p>\n${inner}\n    </DL><p>` : inner;
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    head,
    '</DL><p>',
  ].join('\n');
}

test('解析最简单的单层书签 HTML', () => {
  const html = wrap([
    '<DT><A HREF="https://github.com" ADD_DATE="1700000000" ICON="https://github.com/favicon.ico">GitHub</A>',
    '<DT><A HREF="https://example.com" DESCRIPTION="示例站点">Example</A>',
  ].join('\n'));

  const { sites, skipped } = parseBookmarkHtml(html);
  assert.equal(skipped, 0);
  assert.equal(sites.length, 2);
  assert.deepEqual(sites[0], {
    name: 'GitHub',
    url: 'https://github.com',
    desc: '',
    category: '未分组',
    icon: 'https://github.com/favicon.ico',
  });
  assert.equal(sites[1].desc, '示例站点');
  assert.equal(sites[1].icon, '');
  // 解析结果不带 id，由服务端生成。
  assert.equal('id' in sites[0], false);
  // 解析书签文件不接受 keywords。
  assert.equal('keywords' in sites[0], false);
});

test('嵌套文件夹用最内层文件夹名作为分类', () => {
  const html = wrap([
    '    <DT><H3>外层</H3>',
    '    <DL><p>',
    '        <DT><H3>内层</H3>',
    '        <DL><p>',
    '            <DT><A HREF="https://deep.example.com">深层</A>',
    '        </DL><p>',
    '        <DT><A HREF="https://outer.example.com">外层链接</A>',
    '    </DL><p>',
  ].join('\n'), '顶层');

  const { sites } = parseBookmarkHtml(html);
  assert.deepEqual(sites.map((s) => [s.name, s.category]), [
    ['深层', '内层'],
    ['外层链接', '外层'],
  ]);
});

test('解码 HTML 实体（命名实体、&#39; 与十六进制实体）', () => {
  const html = wrap(
    '<DT><A HREF="https://example.com/?a=1&amp;b=2" DESCRIPTION="A &lt;B&gt; &quot;C&quot;">Tom&#39;s &amp; Jerry &#x1F600;</A>',
  );

  const { sites } = parseBookmarkHtml(html);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].name, "Tom's & Jerry \u{1f600}");
  assert.equal(sites[0].desc, 'A <B> "C"');
  assert.equal(sites[0].url, 'https://example.com/?a=1&b=2');
});

test('跳过 javascript: 与 data: 链接并计入 skipped', () => {
  const html = wrap([
    '<DT><A HREF="javascript:alert(1)">坏脚本</A>',
    '<DT><A HREF="data:text/html,hi">内联页面</A>',
    '<DT><A HREF="ftp://files.example.com">FTP</A>',
    '<DT><A HREF="/relative/path">相对路径</A>',
    '<DT><A HREF="https://ok.example.com">正常站点</A>',
  ].join('\n'));

  const { sites, skipped } = parseBookmarkHtml(html);
  assert.equal(skipped, 4);
  assert.deepEqual(sites.map((s) => s.url), ['https://ok.example.com']);
});

test('重复 url 去重并计入 skipped', () => {
  const html = wrap([
    '<DT><A HREF="https://dup.example.com">第一次</A>',
    '<DT><A HREF="https://dup.example.com">第二次</A>',
    '<DT><A HREF="https://dup.example.com/?x=1&amp;y=2">A</A>',
    '<DT><A HREF="https://dup.example.com/?x=1&y=2">B</A>',
  ].join('\n'));

  const { sites, skipped } = parseBookmarkHtml(html);
  assert.equal(sites.length, 2);
  assert.equal(skipped, 2);
  assert.equal(sites[0].name, '第一次');
});

test('超长名称与描述会被截断', () => {
  const longName = 'n'.repeat(80);
  const longDesc = 'd'.repeat(160);
  const longCategory = 'c'.repeat(45);
  const html = wrap(
    `<DT><A HREF="https://long.example.com" DESCRIPTION="${longDesc}">${longName}</A>`,
    longCategory,
  );

  const { sites } = parseBookmarkHtml(html);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].name.length, 50);
  assert.equal(sites[0].desc.length, 100);
  assert.equal(sites[0].category.length, 30);
});

test('名称为空时用域名兜底', () => {
  const html = wrap('<DT><A HREF="https://www.fallback.example.com/x">   </A>');
  const { sites } = parseBookmarkHtml(html);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].name, 'fallback.example.com');
});

test('非字符串输入返回空结果', () => {
  for (const input of [null, undefined, 42, {}, []]) {
    assert.deepEqual(parseBookmarkHtml(input), { sites: [], skipped: 0 });
  }
});

test('导出的 Netscape HTML 再解析回来保持一致', () => {
  const original = [
    {
      name: 'GitHub',
      url: 'https://github.com',
      desc: '代码托管',
      category: '开发',
      icon: 'https://github.com/favicon.ico',
    },
    { name: 'A & B', url: 'https://example.com/?a=1&b=2', desc: '', category: '开发', icon: '' },
    { name: '文档', url: 'https://docs.example.com', desc: '说明', category: '学习', icon: '' },
  ];

  const html = toNetscapeHtml(original);
  assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  const { sites, skipped } = parseBookmarkHtml(html);
  assert.equal(skipped, 0);
  assert.deepEqual(sites, original);
});

test('toNetscapeHtml 按分类分组并保持首次出现顺序', () => {
  const html = toNetscapeHtml([
    { name: 'B1', url: 'https://b.example.com', category: '乙' },
    { name: 'A1', url: 'https://a.example.com', category: '甲' },
    { name: 'B2', url: 'https://b2.example.com', category: '乙' },
  ]);

  const categories = [...html.matchAll(/<H3>([^<]*)<\/H3>/g)].map((m) => m[1]);
  assert.deepEqual(categories, ['乙', '甲']);
  assert.ok(html.indexOf('B1') < html.indexOf('B2'));
  const folders = [...html.matchAll(/<DL><p>/g)].length;
  const closing = [...html.matchAll(/<\/DL><p>/g)].length;
  assert.equal(folders, closing);
});

test('toNetscapeHtml 正确转义 &、< 与引号', () => {
  const html = toNetscapeHtml([
    { name: 'A & <B> "C"', url: 'https://example.com/?a=1&b=2', category: 'X<Y' },
  ]);

  assert.ok(html.includes('A &amp; &lt;B&gt; &quot;C&quot;'));
  assert.ok(html.includes('HREF="https://example.com/?a=1&amp;b=2"'));
  assert.ok(html.includes('<H3>X&lt;Y</H3>'));
  // 不允许出现未转义的原始字符。
  assert.equal(html.includes('A & <B>'), false);
});

test('toNetscapeHtml 非数组输入返回空骨架', () => {
  for (const input of [null, undefined, 'nope', {}]) {
    const html = toNetscapeHtml(input);
    assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
    assert.ok(html.includes('<DL><p>'));
    assert.ok(html.endsWith('</DL><p>'));
    assert.equal(html.includes('<DT><A'), false);
  }
});

test('toJson 与 parseJson 往返保留 pinned 与 keywords', () => {
  const sites = [
    {
      id: 'server-generated',
      name: 'GitHub',
      url: 'https://github.com',
      desc: '代码托管',
      category: '开发',
      icon: '\u{1f431}',
      pinned: true,
      keywords: 'git, 仓库',
    },
    { name: 'Docs', url: 'https://docs.example.com', desc: '', category: '文档', icon: '' },
  ];
  const settings = { title: '我的导航', subtitle: '副标题', density: 'compact', junk: '丢弃' };

  const parsed = JSON.parse(toJson(sites, settings));
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.exportedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(parsed.exportedAt)));
  assert.deepEqual(Object.keys(parsed.sites[0]), ['name', 'url', 'desc', 'category', 'icon', 'pinned', 'keywords']);
  assert.deepEqual(Object.keys(parsed.sites[1]), ['name', 'url', 'desc', 'category', 'icon']);

  const result = parseJson(toJson(sites, settings));
  assert.deepEqual(result.sites, [
    {
      name: 'GitHub',
      url: 'https://github.com',
      desc: '代码托管',
      category: '开发',
      icon: '\u{1f431}',
      pinned: true,
      keywords: 'git, 仓库',
    },
    { name: 'Docs', url: 'https://docs.example.com', desc: '', category: '文档', icon: '' },
  ]);
  assert.deepEqual(result.settings, { title: '我的导航', subtitle: '副标题', density: 'compact' });
});

test('toJson 在无 settings 时输出空对象', () => {
  const parsed = JSON.parse(toJson([], undefined));
  assert.deepEqual(parsed.settings, {});
  assert.deepEqual(parsed.sites, []);
});

test('parseJson 对坏输入抛错', () => {
  const message = '文件格式不正确，需要本站在「导出」里生成的 JSON';
  assert.throws(() => parseJson('not json{'), { message });
  assert.throws(() => parseJson(JSON.stringify([1, 2, 3])), { message });
  assert.throws(() => parseJson(JSON.stringify({ version: 1, sites: 'nope' })), { message });
  assert.throws(() => parseJson('null'), { message });
});

test('parseJson 丢掉非法 url 的条目而不抛错', () => {
  const text = JSON.stringify({
    version: 1,
    sites: [
      { name: 'ok', url: 'https://ok.example.com' },
      { name: 'bad-js', url: 'javascript:alert(1)' },
      { name: 'bad-rel', url: '/relative' },
      { name: 'bad-empty', url: '' },
      { name: 5, url: 'https://noname.example.com' },
      'not-an-object',
      { name: 'dup', url: 'https://ok.example.com' },
    ],
  });

  const { sites, settings } = parseJson(text);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].url, 'https://ok.example.com');
  assert.deepEqual(settings, {});
});

test('parseJson 截断字段并丢弃非法 settings', () => {
  const text = JSON.stringify({
    version: 1,
    settings: { title: 't'.repeat(80), subtitle: 's'.repeat(150), density: 'huge', extra: 'x' },
    sites: [
      {
        name: 'n'.repeat(80),
        url: 'https://long.example.com',
        desc: 'd'.repeat(150),
        category: 'c'.repeat(45),
        icon: 'i'.repeat(20),
        keywords: 'k'.repeat(150),
        pinned: 'yes',
      },
    ],
  });

  const { sites, settings } = parseJson(text);
  assert.deepEqual(settings, { title: 't'.repeat(50), subtitle: 's'.repeat(100) });
  assert.equal(sites[0].name.length, 50);
  assert.equal(sites[0].desc.length, 100);
  assert.equal(sites[0].category.length, 30);
  assert.equal(sites[0].icon.length, 8);
  assert.equal(sites[0].keywords.length, 100);
  // pinned 只接受布尔 true。
  assert.equal('pinned' in sites[0], false);
});

test('parseJson 接受空站点列表', () => {
  const { sites, settings } = parseJson(JSON.stringify({ version: 1, sites: [], settings: {} }));
  assert.deepEqual(sites, []);
  assert.deepEqual(settings, {});
});

test('JSON 往返保留 tags 与 note', () => {
  const sites = [
    {
      name: '内网面板',
      url: 'https://panel.example.com',
      desc: '集群面板',
      category: '运维',
      icon: '',
      tags: '运维, 内网',
      note: '账号在 1Password；需先连 VPN',
    },
    { name: 'GitHub', url: 'https://github.com', category: '开发' },
  ];

  const text = toJson(sites, { title: '工具箱' });
  const parsed = parseJson(text);

  assert.equal(parsed.sites[0].tags, '运维, 内网');
  assert.equal(parsed.sites[0].note, '账号在 1Password；需先连 VPN');
  assert.equal('tags' in parsed.sites[1], false, '空 tags 不应出现在导出里');
  assert.equal('note' in parsed.sites[1], false);
});

test('导入时超长的 tags / note 会被截断', () => {
  const text = JSON.stringify({
    version: 1,
    sites: [{ name: 'A', url: 'https://a.example.com', tags: 't'.repeat(150), note: 'n'.repeat(400) }],
  });
  const parsed = parseJson(text);
  assert.equal(parsed.sites[0].tags.length, 100);
  assert.equal(parsed.sites[0].note.length, 200);
});
