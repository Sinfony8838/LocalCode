import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOCALES, isAppLocale, LOCALE_NAMES, translate, translations } from '../src/shared/i18n';
import { setLocale, t, errorText } from '../src/renderer/i18n';
import { LanguageControl, sessionTitle } from '../src/renderer/App';
import type { SessionView } from '../src/shared/contracts';

afterEach(() => setLocale('zh-CN'));

describe('application languages', () => {
  it('accepts only supported locales and preserves unknown content', () => {
    for (const locale of APP_LOCALES) {
      expect(isAppLocale(locale)).toBe(true);
      expect(translate(locale, 'user/path/你好.ts')).toBe('user/path/你好.ts');
    }
    for (const value of [null, {}, 'fr', 'EN', 'ja-JP', '__proto__']) expect(isAppLocale(value)).toBe(false);
  });

  it('provides three complete translations with the same interpolation parameters', () => {
    expect(Object.keys(translations).length).toBeGreaterThan(250);
    const parameters = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const [source, entries] of Object.entries(translations)) {
      expect(entries, source).toHaveLength(3);
      for (const entry of entries) {
        expect(entry.trim().length, source).toBeGreaterThan(0);
        expect(parameters(entry), source).toEqual(parameters(source));
      }
    }
  });

  it('interpolates values literally without changing paths, code or identifiers', () => {
    const file = '项目/{name}/$&.tsx';
    expect(translate('en', '打开文件 {path}', { path: file })).toBe(`Open file ${file}`);
    expect(translate('zh-CN', '打开文件 {path}', { path: file })).toBe(`打开文件 ${file}`);
  });

  it('translates empty default conversation titles and preserves user conversation content', () => {
    setLocale('en');
    const session: SessionView = { id: 's', projectId: 'p', providerId: 'local', title: '新会话', status: 'idle', createdAt: '', updatedAt: '', messages: [], tools: [] };
    expect(sessionTitle(session)).toBe('New conversation');
    session.messages.push({ id: 'm', role: 'user', text: '新会话', createdAt: '' });
    expect(sessionTitle(session)).toBe('新会话');
    session.title = '我的项目'; session.messages = [];
    expect(sessionTitle(session)).toBe('我的项目');
  });

  it('localizes known IPC errors after removing Electron wrapping', () => {
    setLocale('en');
    const source = '此角色的原始图集尚未导入。';
    const wrapped = new Error(`Error invoking remote method 'localcode:pet': Error: ${source}`);
    expect(t(errorText(wrapped))).toBe(t(source));
    expect(t(errorText(String(wrapped)))).toBe(t(source));
    expect(t(errorText(wrapped))).not.toContain(source);
    expect(errorText(new Error('remote diagnostic: 用户数据'))).toBe('remote diagnostic: 用户数据');
  });

  it.each(APP_LOCALES)('renders language settings and the explicit-request explanation in %s', locale => {
    setLocale(locale);
    const html = renderToStaticMarkup(<LanguageControl value={locale} onChange={async () => {}} />);
    for (const name of Object.values(LOCALE_NAMES)) expect(html).toContain(name);
    expect(html).toContain(`value="${locale}" lang="${locale}" selected=""`);
    expect(html).toContain(t('界面与交互语言'));
  });

  it('registers every renderer t() literal, tool/status label, and dynamic budget template', () => {
    const rendererDir = path.resolve('src/renderer');
    const missing: string[] = [];
    for (const file of fs.readdirSync(rendererDir).filter(name => /\.(ts|tsx)$/.test(name))) {
      const code = fs.readFileSync(path.join(rendererDir, file), 'utf8');
      for (const match of code.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)+)\1/g)) {
        const key = match[2]
          .replaceAll('\\n', '\n')
          .replaceAll('\\r', '\r')
          .replaceAll('\\t', '\t')
          .replaceAll('\\"', '"')
          .replaceAll("\\'", "'")
          .replaceAll('\\\\', '\\');
        if (key !== ' {label}' && !(key in translations)) {
          missing.push(`${file}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);

    for (const locale of APP_LOCALES) {
      if (locale === 'zh-CN') continue;
      for (const label of ['文件大纲', '探索代码库', '读取网页', '后台运行命令', '查看后台输出', '停止后台命令', '确认方案', '提出计划', '查看目标', '更新目标状态', '继续推进目标', '文件引用建议', '添加', '思考深度']) {
        expect(translate(locale, label), `${locale} -> ${label}`).not.toBe(label);
      }
      const budgetErr = translate(locale, '本轮 {limit} 次工具调用预算已耗尽，未继续执行工具。已收到的回复和文件修改已保留；请根据实际验证结果判断完成情况，需要继续时请发送新消息。', { limit: 100 });
      expect(budgetErr).toContain('100');
      expect(budgetErr).not.toContain('{limit}');
      const budgetNote = translate(locale, '本轮 {limit} 次工具调用预算已耗尽，正在根据已有结果生成最后一条总结；不会再执行工具。', { limit: 100 });
      expect(budgetNote).toContain('100');
      expect(budgetNote).not.toContain('{limit}');
    }
  });
});
