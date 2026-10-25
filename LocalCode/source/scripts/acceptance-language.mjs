// Isolated Electron language acceptance. No model service, inference or downloads.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(`../evidence/language-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const home = path.join(root, 'home');
const project = path.join(root, 'project');
const checks = [], errors = [];
const userContent = 'const 提示 = "保留用户原文";\n';
await fs.mkdir(path.join(home, 'data/pets'), { recursive: true });
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, '用户代码.txt'), userContent);

// A synthetic transparent PNG atlas exercises the separate pet renderer without
// using copyrighted artwork or changing the user's existing companion settings.
function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) { result ^= byte; for (let i = 0; i < 8; i++) result = result >>> 1 ^ (result & 1 ? 0xedb88320 : 0); }
  return (result ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([size, body, crc]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(1536); header.writeUInt32BE(2288, 4); header[8] = 8; header[9] = 6;
await fs.writeFile(path.join(home, 'data/pets/paimon.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((1536 * 4 + 1) * 2288))), chunk('IEND', Buffer.alloc(0))]));
await fs.writeFile(path.join(home, 'data/pets.json'), JSON.stringify({ enabled: true, selected: 'paimon', size: 128, alwaysOnTop: false, paused: true, followCursor: false }));

const expected = {
  'zh-CN': { language: '语言', select: '界面与交互语言', newTask: '新建任务', input: '任务输入', provider: '供应商名称', models: '模型设置', pets: '桌宠设置', viewer: '文件查看器', source: '源码', picker: '选择编程项目', balloon: '陪你在本地写代码', open: '打开 LocalCode', close: '关闭设置' },
  en: { language: 'Language', select: 'Interface and interaction language', newTask: 'New task', input: 'Task input', provider: 'Provider name', models: 'Model settings', pets: 'Desktop companion settings', viewer: 'File viewer', source: 'Source', picker: 'Select a coding project', balloon: 'Coding locally by your side', open: 'Open LocalCode', close: 'Close settings' },
  ja: { language: '言語', select: '画面と対話の言語', newTask: '新しいタスク', input: 'タスクの入力', provider: 'プロバイダー名', models: 'モデル設定', pets: 'デスクトップの旅の仲間の設定', viewer: 'ファイルビューアー', source: 'ソース', picker: 'コーディングプロジェクトを選択', balloon: 'ローカルでの開発をお手伝いします', open: 'LocalCode を開く', close: '設定を閉じる' },
  ko: { language: '언어', select: '화면 및 대화 언어', newTask: '새 작업', input: '작업 입력', provider: '공급자 이름', models: '모델 설정', pets: '데스크톱 동반자 설정', viewer: '파일 뷰어', source: '소스', picker: '코딩 프로젝트 선택', balloon: '곁에서 로컬 코딩을 함께합니다', open: 'LocalCode 열기', close: '설정 닫기' },
};
const executable = process.argv[2];
const navigation = {
  'zh-CN': { home: '返回首页', heading: '首页', workspace: '选择工作项目', outside: '不在项目中工作', pin: '置顶项目', unpin: '取消置顶项目' },
  en: { home: 'Go home', heading: 'Home', workspace: 'Choose a project', outside: 'Work outside a project', pin: 'Pin project', unpin: 'Unpin project' },
  ja: { home: 'ホームに戻る', heading: 'ホーム', workspace: '作業プロジェクトを選択', outside: 'プロジェクト外で作業', pin: 'プロジェクトを固定', unpin: 'プロジェクトの固定を解除' },
  ko: { home: '홈으로 이동', heading: '홈', workspace: '작업 프로젝트 선택', outside: '프로젝트 밖에서 작업', pin: '프로젝트 고정', unpin: '프로젝트 고정 해제' },
};
const env = { ...process.env, LOCALCODE_HOME: home, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, pet;
async function launch(locale = 'zh-CN') {
  await fs.mkdir(env.TEMP, { recursive: true });
  const runtime = executable || process.env.LOCALCODE_ELECTRON_PATH || require('electron');
  assert.equal(typeof runtime, 'string');
  assert((await fs.stat(runtime)).isFile());
  app = await electron.launch({ executablePath: runtime, args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  for (let i = 0; i < 100; i++) {
    page = app.windows().find(p => /\/index\.html$/.test(p.url()));
    pet = app.windows().find(p => /\/pet\.html$/.test(p.url()));
    if (page && pet) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(page && pet, 'Main and companion windows must exist');
  for (const window of [page, pet]) window.on('pageerror', error => errors.push(error.message));
  await page.getByLabel(expected[locale].input, { exact: true }).waitFor();
  await pet.locator('.lc-pet-balloon').waitFor();
  await app.evaluate(({ dialog }, folder) => {
    globalThis.languagePickerTitles = [];
    dialog.showOpenDialog = async (_window, options) => { globalThis.languagePickerTitles.push(options.title); return { canceled: false, filePaths: [folder] }; };
  }, project);
}
async function assertLocale(locale) {
  const text = expected[locale];
  await page.waitForFunction(value => document.documentElement.lang === value, locale);
  await pet.waitForFunction(value => document.documentElement.lang === value, locale);
  // The sidebar may be collapsed after opening an artifact; its text still
  // updates and becomes visible when the user expands it again.
  assert.equal(await page.locator('.new-task-button').textContent(), text.newTask);
  await page.getByLabel(text.input, { exact: true }).waitFor();
  const modes = {
    'zh-CN': ['审批模式','请求批准','完全访问权限'],
    en: ['Approval mode','Ask for approval','Full access'],
    ja: ['承認モード','承認を求める','フルアクセス'],
    ko: ['승인 모드','승인 요청','전체 액세스'],
  }[locale];
  assert.equal(await page.getByRole('button',{name:modes[0],exact:true}).count(),1);
  assert.equal((await page.evaluate(() => window.localcode.bootstrap())).settings.locale, locale);
  assert.equal(await pet.locator('.lc-pet-balloon').innerText(), text.balloon);
  assert.equal(await pet.locator('.lc-pet-toolbar button').first().getAttribute('aria-label'), text.open);
}
// The user-menu trigger is nested in its own anchor below the settings button.
async function settings() { await page.locator('.activity-rail > button').last().click(); await page.locator('.settings-dialog').waitFor(); }
async function languageTab() { await page.locator('.settings-nav button').nth(1).click(); }

try {
  await launch();
  assert.equal((await page.evaluate(() => window.localcode.bootstrap())).settings.locale, 'zh-CN');
  checks.push('new profiles default to Simplified Chinese');
  for (const locale of ['en', 'ja', 'ko', 'zh-CN']) {
    const text = expected[locale];
    await settings(); await languageTab();
    await page.locator('.settings-content select').selectOption(locale);
    await assertLocale(locale);
    await page.getByLabel(text.select, { exact: true }).waitFor();
    assert.equal(await page.locator('.settings-nav button').nth(1).innerText(), text.language);
    await page.screenshot({ path: path.join(root, `settings-${locale}.png`) });
    await page.locator('.settings-nav button').first().click();
    await page.getByLabel(text.provider, { exact: true }).waitFor();
    assert.equal(await page.locator('.settings-nav button').first().innerText(), text.models);
    await page.locator('.settings-nav button').nth(3).click();
    await page.getByRole('region', { name: text.pets, exact: true }).waitFor();
    await page.getByRole('button', { name: text.close, exact: true }).click();
    await page.getByRole('button',{name: {'zh-CN':'审批模式',en:'Approval mode',ja:'承認モード',ko:'승인 모드'}[locale],exact:true}).click();
    await page.getByRole('menuitemradio').filter({hasText:{'zh-CN':'完全访问权限',en:'Full access',ja:'フルアクセス',ko:'전체 액세스'}[locale]}).waitFor();
    await page.keyboard.press('Escape');
    const nav = navigation[locale];
    await page.getByRole('button', { name: nav.home, exact: true }).click();
    assert.equal(await page.locator('.workspace-heading h1').innerText(), nav.heading);
    await page.getByRole('button', { name: nav.workspace, exact: true }).click();
    await page.getByRole('option', { name: nav.outside, exact: true }).click();
    assert.equal(await page.getByLabel(text.input, { exact: true }).isEnabled(), true);
    await page.locator('.activity-rail button').nth(2).click();
    assert.equal((await app.evaluate(() => globalThis.languagePickerTitles)).at(-1), text.picker);
    await page.locator('.project-item.active').waitFor({ state: 'attached' });
    await page.locator('.project-more').first().click();
    await page.getByRole('menuitem', { name: nav.pin, exact: true }).click();
    await page.locator('.project-more').first().click();
    await page.getByRole('menuitem', { name: nav.unpin, exact: true }).click();
    await page.locator('.activity-rail button').nth(3).click();
    await page.locator('.inspector-tabs button').nth(1).click();
    await page.getByRole('button', { name: '用户代码.txt', exact: true }).click();
    await page.getByRole('complementary', { name: text.viewer, exact: true }).waitFor();
    assert.equal(await page.locator('.artifact-source').innerText(), userContent);
    assert.equal(await page.locator('.artifact-toolbar [role="group"] button').nth(1).innerText(), text.source);
    await page.locator('.artifact-header button').last().click();
    if ((await page.locator('.app-shell').getAttribute('class')).includes('sidebar-hidden')) await page.locator('.activity-rail button').nth(1).click();
    checks.push(`${locale}: language selector, projectless picker, home and project pin/unpin, model/pet settings, floating companion, native picker and file viewer; user file text preserved`);
  }
  const before = (await page.evaluate(() => window.localcode.bootstrap())).settings.locale;
  for (const value of ['fr', 'en-US', '', null, {}, 1]) {
    const result = await page.evaluate(async invalid => { try { await window.localcode.setLocale(invalid); return 'accepted'; } catch { return 'rejected'; } }, value);
    assert.equal(result, 'rejected');
    assert.equal((await page.evaluate(() => window.localcode.bootstrap())).settings.locale, before);
  }
  checks.push('IPC rejects unsupported, empty, null and incorrectly typed locales without changing settings');
  await settings(); await languageTab(); await page.locator('.settings-content select').selectOption('ko'); await assertLocale('ko');
  await app.close(); app = undefined;
  const durable = JSON.parse(await fs.readFile(path.join(home, 'data/index.json'), 'utf8'));
  assert.equal(durable.settings.locale, 'ko');
  await launch('ko'); await assertLocale('ko');
  checks.push('Korean persists in the data index and both renderer windows after a full restart');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ checks, errors, modelInference: 'NOT_RUN', modelService: 'NOT_STARTED', isolatedHome: home }, null, 2));
  console.log(JSON.stringify({ root, checks, errors }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify({ checks, errors, failure: error.stack }, null, 2));
  throw error;
} finally { await app?.close().catch(() => {}); }
