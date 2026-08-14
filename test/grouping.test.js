'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');
const { loadFixture } = require('./helpers.js');

test('classifyPr: fix labels win over everything', () => {
  assert.equal(core.classifyPr({ title: 'Add shiny thing', labels: [{ name: 'Bug' }] }), 'fixes');
  assert.equal(core.classifyPr({ title: 'Whatever', labels: [{ name: 'regression' }] }), 'fixes');
});

test('classifyPr: feature labels', () => {
  assert.equal(core.classifyPr({ title: 'CSV export for reports', labels: [{ name: 'enhancement' }] }), 'features');
  assert.equal(core.classifyPr({ title: 'Plain title', labels: [{ name: 'Feature' }] }), 'features');
});

test('classifyPr: conventional-commit prefixes in titles', () => {
  assert.equal(core.classifyPr({ title: 'feat: add dark mode', labels: [] }), 'features');
  assert.equal(core.classifyPr({ title: 'feat(ui)!: new layout', labels: [] }), 'features');
  assert.equal(core.classifyPr({ title: 'fix(parser): handle unicode titles', labels: [] }), 'fixes');
  assert.equal(core.classifyPr({ title: 'Fix crash on startup', labels: [] }), 'fixes');
  assert.equal(core.classifyPr({ title: 'Fixed flaky retry loop', labels: [] }), 'fixes');
});

test('classifyPr: plain-word feature verbs', () => {
  assert.equal(core.classifyPr({ title: 'Add telemetry opt-out', labels: [] }), 'features');
  assert.equal(core.classifyPr({ title: 'Support Python 3.13', labels: [] }), 'features');
  assert.equal(core.classifyPr({ title: 'Implement retry backoff', labels: [] }), 'features');
});

test('classifyPr: everything else lands in other', () => {
  assert.equal(core.classifyPr({ title: 'Bump lodash from 4.17.21 to 5.0.0', labels: [{ name: 'dependencies' }] }), 'other');
  assert.equal(core.classifyPr({ title: 'docs: update readme', labels: [] }), 'other');
  assert.equal(core.classifyPr({ title: 'chore: tidy CI config', labels: [] }), 'other');
  assert.equal(core.classifyPr({ title: 'Refactor storage layer', labels: [] }), 'other');
});

test('cleanTitle strips conventional prefixes and capitalizes', () => {
  assert.equal(core.cleanTitle('feat: add dark mode'), 'Add dark mode');
  assert.equal(core.cleanTitle('fix(parser): handle unicode titles'), 'Handle unicode titles');
  assert.equal(core.cleanTitle('docs: update readme'), 'Update readme');
  assert.equal(core.cleanTitle('chore(deps)!: drop node 16'), 'Drop node 16');
  assert.equal(core.cleanTitle('Bump lodash from 4.17.21 to 5.0.0'), 'Bump lodash from 4.17.21 to 5.0.0');
  assert.equal(core.cleanTitle('  padded title  '), 'Padded title');
});

test('groupPrs sorts each group by merge time, oldest first', () => {
  const prs = [
    { number: 2, title: 'feat: second', labels: [], merged_at: '2026-07-20T00:00:00Z' },
    { number: 1, title: 'feat: first', labels: [], merged_at: '2026-07-05T00:00:00Z' },
  ];
  const groups = core.groupPrs(prs);
  assert.deepEqual(groups.features.map((p) => p.number), [1, 2]);
  assert.deepEqual(groups.fixes, []);
  assert.deepEqual(groups.other, []);
});

test('renderMarkdown produces grouped sections and the changelog link', () => {
  const prs = loadFixture('pulls-page1').filter(
    (pr) => pr.merged_at && Date.parse(pr.merged_at) > Date.parse('2026-07-01T00:00:00Z')
  );
  const groups = core.groupPrs(prs);
  const markdown = core.renderMarkdown({ groups, owner: 'acme', repo: 'widget', baseTag: 'v1.2.0', headRef: 'main' });
  assert.equal(
    markdown,
    [
      '## Features',
      '',
      '- CSV export for reports (#46)',
      '- Add dark mode (#50)',
      '',
      '## Fixes',
      '',
      '- Crash when parsing empty changelog (#49)',
      '',
      '## Other changes',
      '',
      '- Update readme (#47)',
      '- Bump lodash from 4.17.21 to 5.0.0 (#48)',
      '',
      '**Full Changelog**: https://github.com/acme/widget/compare/v1.2.0...main',
      '',
    ].join('\n')
  );
});

test('renderMarkdown omits empty sections', () => {
  const groups = core.groupPrs([{ number: 7, title: 'fix: leak', labels: [], merged_at: '2026-07-02T00:00:00Z' }]);
  const markdown = core.renderMarkdown({ groups, owner: 'acme', repo: 'widget', baseTag: 'v1.0.0', headRef: 'main' });
  assert.ok(!markdown.includes('## Features'));
  assert.ok(!markdown.includes('## Other changes'));
  assert.ok(markdown.startsWith('## Fixes'));
});

test('renderMarkdown returns empty string when there is nothing to list', () => {
  const markdown = core.renderMarkdown({
    groups: { features: [], fixes: [], other: [] },
    owner: 'acme',
    repo: 'widget',
    baseTag: 'v1.2.0',
    headRef: 'main',
  });
  assert.equal(markdown, '');
});

test('renderMarkdown skips the changelog link without a baseline tag', () => {
  const groups = core.groupPrs([{ number: 7, title: 'fix: leak', labels: [], merged_at: '2026-07-02T00:00:00Z' }]);
  const markdown = core.renderMarkdown({ groups, owner: 'acme', repo: 'widget', baseTag: null, headRef: 'main' });
  assert.ok(!markdown.includes('Full Changelog'));
});
