import React, { useState } from 'react';
import { AlertCircle, Box, Check, Cpu, Eye, EyeOff, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2, Unplug, Zap } from 'lucide-react';
import type { AppSettings, ModelConfig, ModelHealth, ProviderConfig } from '../shared/contracts';
import { ARK_ANTHROPIC_URL, ARK_OPENAI_URL, providerModels } from '../shared/providers';

type ProviderInput = Omit<ProviderConfig, 'hasKey'> & { apiKey?: string };
const fromProvider = (p: ProviderConfig): ProviderInput => {
  const { hasKey, ...rest } = p;
  return { ...rest, enabled: p.enabled !== false, models: providerModels(p), apiKey: '' };
};
const fresh = (ark: boolean): ProviderInput => ({ id: crypto.randomUUID(), name: ark ? '火山方舟 Coding Plan' : '', kind: ark ? 'anthropic' : 'openai',
  baseUrl: ark ? ARK_ANTHROPIC_URL : '', model: ark ? 'ark-code-latest' : '', contextWindow: 32768, maxTokens: 4096, enabled: true, apiKey: '',
  models: [{ id: ark ? 'ark-code-latest' : '', contextWindow: 32768, maxTokens: 4096, enabled: true }] });
const errorText = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e);

export default function ModelSettings({ settings, health, onHealth, healthPending, onSaved }: {
  settings: AppSettings; health: ModelHealth; onHealth: () => Promise<void>; healthPending: boolean; onSaved: () => Promise<unknown>;
}) {
  const [form, setForm] = useState<ProviderInput>(() => fromProvider(settings.providers[0]));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const existing = settings.providers.find(p => p.id === form.id);
  const local = form.kind === 'ollama';
  const locked = busy || Boolean(testing);
  const models = form.models!;
  const reset = (next: ProviderInput) => { setForm(next); setDirty(!settings.providers.some(p => p.id === next.id)); setShowKey(false); setFeedback(''); setError(''); setConfirmDelete(false); };
  const update = (patch: Partial<ProviderInput>) => { setForm(previous => ({ ...previous, ...patch })); setDirty(true); setFeedback(''); setError(''); };
  const updateModel = (index: number, patch: Partial<ModelConfig>) => update({ models: models.map((m, i) => i === index ? { ...m, ...patch } : m) });
  const changeKind = (kind: ProviderInput['kind']) => {
    const ark = [ARK_ANTHROPIC_URL, ARK_OPENAI_URL].includes(form.baseUrl.replace(/\/$/, ''));
    update({ kind, ...(ark ? { baseUrl: kind === 'anthropic' ? ARK_ANTHROPIC_URL : ARK_OPENAI_URL } : {}) });
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setFeedback('');
    try {
      const cleaned = models.map(m => ({ ...m, id: m.id.trim() }));
      const primary = cleaned.find(m => m.enabled) || cleaned[0];
      const saved = await window.localcode.saveProvider({ ...form, name: form.name.trim(), baseUrl: form.baseUrl.trim().replace(/\/$/, ''),
        model: primary.id, contextWindow: primary.contextWindow, maxTokens: primary.maxTokens,
        ...(local ? { models: undefined } : { models: cleaned }), apiKey: form.apiKey?.trim() || undefined });
      await onSaved(); setForm(fromProvider(saved)); setDirty(false); setShowKey(false); setFeedback('设置已保存。可在输入框下方手动选择此模型。');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const test = async (modelId: string) => {
    setTesting(modelId); setError(''); setFeedback('');
    try { const result = await window.localcode.testProvider({ providerId: form.id, modelId }); setFeedback(result.message); }
    catch (e) { setError(errorText(e)); } finally { setTesting(''); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await window.localcode.deleteProvider(form.id); await onSaved(); reset(fromProvider(settings.providers.find(p => p.kind === 'ollama')!)); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <div className="model-settings">
    <div className="model-settings-heading"><div className="settings-section-heading"><h3>模型设置</h3><p>管理模型供应商，配置后可在聊天时选择使用。</p></div><button className="primary-button" disabled={locked} onClick={() => reset(fresh(true))}><Plus size={15} />添加供应商</button></div>
    <div className="provider-workspace">
      <aside className="provider-list"><span className="provider-group-label">本地模型</span>{settings.providers.filter(p => p.kind === 'ollama').map(p => <button key={p.id} disabled={locked} className={form.id === p.id ? 'active' : ''} onClick={() => reset(fromProvider(p))}><Cpu size={16} /><span>{p.name}</span><i className={`status-dot ${health.online && health.modelAvailable ? 'online' : 'offline'}`} /></button>)}
        <span className="provider-group-label">自定义供应商</span>{settings.providers.filter(p => p.kind !== 'ollama').map(p => <button key={p.id} disabled={locked} className={form.id === p.id ? 'active' : ''} onClick={() => reset(fromProvider(p))}><Box size={16} /><span>{p.name}</span><i className={`status-dot ${p.enabled !== false && p.hasKey && providerModels(p).some(m => m.enabled) ? 'online' : 'offline'}`} /></button>)}
        {!existing && <button className="active" disabled><Box size={16} /><span>{form.name || '新供应商'}</span><small>草稿</small></button>}
        <div className="provider-presets"><span className="provider-group-label">快速配置</span><button disabled={locked} onClick={() => reset(fresh(true))}><Zap size={15} />火山 Coding Plan</button><button disabled={locked} onClick={() => reset(fresh(false))}><Plus size={15} />自定义 API</button></div>
        <p className="provider-list-note">状态圆点表示配置已启用。连通性以手动测试结果为准。</p>
      </aside>
      <form className="provider-form provider-detail" onSubmit={event => void save(event)}>
        <div className="provider-detail-heading"><Box size={21} /><strong>{form.name || '新供应商'}</strong>{dirty && <small>未保存</small>}<label className="provider-switch"><input aria-label="启用供应商" type="checkbox" checked={form.enabled !== false} disabled={local || locked} onChange={e => update({ enabled: e.target.checked })} /><span /></label></div>
        {local && <div className="connection-card"><Cpu size={17} /><div><strong>{health.online && health.modelAvailable ? 'Ollama 已连接' : '本地模型尚未就绪'}</strong><p>{health.message || `${health.model} · ${health.contextWindow} tokens`}</p></div><button type="button" className="icon-button" aria-label="刷新 Ollama 状态" onClick={() => void onHealth()} disabled={healthPending}><RefreshCw size={15} className={healthPending ? 'spin' : ''} /></button></div>}
        <fieldset disabled={locked || local} className="provider-fields">
          <label className="field"><span>供应商名称</span><input aria-label="供应商名称" required maxLength={80} value={form.name} placeholder="例如：火山方舟" onChange={e => update({ name: e.target.value })} /></label>
          <label className="field"><span>Base URL</span><input aria-label="Base URL" type="url" required value={form.baseUrl} placeholder="https://api.example.com/v1" onChange={e => update({ baseUrl: e.target.value })} spellCheck={false} /></label>
          <label className="field"><span>API 格式</span><select aria-label="API 格式" value={form.kind} onChange={e => changeKind(e.target.value as ProviderInput['kind'])}>{local && <option value="ollama">本地 Ollama</option>}<option value="anthropic">Anthropic Messages (/v1/messages)</option><option value="openai">OpenAI Chat Completions (/chat/completions)</option><option value="responses">OpenAI Responses (/responses)</option></select></label>
          {!local && <label className="field"><span>API Key{existing?.hasKey && <em>已加密保存</em>}</span><div className="api-key-input"><input aria-label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" maxLength={4096} value={form.apiKey || ''} placeholder={existing?.hasKey ? '留空保留现有密钥' : '输入 API Key'} onChange={e => update({ apiKey: e.target.value })} spellCheck={false} /><button className="icon-button" type="button" aria-label={showKey ? '隐藏输入的密钥' : '显示输入的密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><small>使用 Windows 加密存储。已保存的密钥不会回传到界面。</small></label>}
        </fieldset>
        {!local && form.baseUrl.includes('ark.cn-beijing.volces.com') && <p className="profile-note">Coding Plan：Anthropic 使用 /api/coding，OpenAI 使用 /api/coding/v3。模型可填 ark-code-latest，跟随方舟控制台选择。上下文与输出上限请按实际模型调整。</p>}
        <div className="model-list-heading"><strong>模型列表</strong>{!local && <button type="button" className="secondary-button" disabled={locked} onClick={() => update({ models: [...models, { id: '', contextWindow: 32768, maxTokens: 4096, enabled: true }] })}><Plus size={14} />添加模型</button>}</div>
        <div className="configured-models">{models.map((m, index) => <div className="configured-model" key={index}>
          <div className="configured-model-heading"><label className="field"><span>模型 ID</span><input aria-label={index === 0 ? '模型 ID' : `模型 ID ${index + 1}`} required maxLength={200} disabled={local || locked} value={m.id} placeholder="ark-code-latest" onChange={e => updateModel(index, { id: e.target.value })} spellCheck={false} /></label>
            {!local && <><button type="button" className="icon-button" title="测试连接（会发送一次少量模型请求）" aria-label={`测试模型 ${index + 1}`} disabled={locked || dirty || !existing?.hasKey || form.enabled === false || !m.enabled} onClick={() => void test(m.id)}>{testing === m.id ? <LoaderCircle size={16} className="spin" /> : <Unplug size={16} />}</button><button type="button" className="icon-button" aria-label={`删除模型 ${index + 1}`} disabled={locked || models.length === 1} onClick={() => update({ models: models.filter((_, i) => i !== index) })}><Trash2 size={16} /></button><label className="provider-switch"><input type="checkbox" aria-label={`启用模型 ${index + 1}`} checked={m.enabled} disabled={locked} onChange={e => updateModel(index, { enabled: e.target.checked })} /><span /></label></>}
          </div>
          <div className="form-two-columns"><label className="field"><span>上下文窗口（tokens）</span><input aria-label={index === 0 ? '上下文窗口' : `上下文窗口 ${index + 1}`} type="number" min={2048} max={2097152} required disabled={local || locked} value={m.contextWindow} onChange={e => updateModel(index, { contextWindow: Number(e.target.value) })} /></label><label className="field"><span>单次输出上限（tokens）</span><input aria-label={index === 0 ? '单次输出上限' : `单次输出上限 ${index + 1}`} type="number" min={128} max={131072} required disabled={local || locked} value={m.maxTokens} onChange={e => updateModel(index, { maxTokens: Number(e.target.value) })} /></label></div>
        </div>)}</div>
        {error && <div className="form-feedback error" role="alert"><AlertCircle size={15} />{error}</div>}{feedback && <div className="form-feedback success" role="status"><Check size={15} />{feedback}</div>}
        {local ? <p className="profile-note">使用本地部署配置，模型能力需自行验证，由应用管理。</p> : <><p className="provider-test-note">保存后点击模型旁的插头测试连接，会发送一次少量请求并消耗对应额度。</p><div className="provider-form-footer"><button type="button" className="secondary-button" disabled={!existing || locked} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除供应商</button><button type="submit" className="primary-button" disabled={locked || !dirty}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存配置</button></div><small className="provider-security-note"><ShieldCheck size={12} />保存后在聊天输入框下方选择供应商和模型。</small></>}
        {confirmDelete && <div className="provider-delete-confirm"><p>删除“{form.name}”及其密钥？历史会话会保留。</p><button type="button" className="secondary-button" disabled={locked} onClick={() => setConfirmDelete(false)}>取消</button><button type="button" className="primary-button" disabled={locked} onClick={() => void remove()}>确认删除供应商</button></div>}
      </form>
    </div>
  </div>;
}
