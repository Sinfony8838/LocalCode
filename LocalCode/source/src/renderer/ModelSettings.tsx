import React, { useState } from 'react';
import { t, useLocale, errorText } from './i18n';
import { providerLabel } from './ModelPicker';
import { AlertCircle, Box, Check, Cpu, Eye, EyeOff, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2, Unplug, Zap } from 'lucide-react';
import type { AppSettings, ModelConfig, ModelHealth, ProviderConfig } from '../shared/contracts';
import { ARK_ANTHROPIC_URL, ARK_OPENAI_URL, providerModels, MANAGED_OLLAMA_URL } from '../shared/providers';

type ProviderInput = Omit<ProviderConfig, 'hasKey'> & { apiKey?: string };
const fromProvider = (p: ProviderConfig): ProviderInput => {
  const { hasKey, ...rest } = p;
  return { ...rest, enabled: p.enabled !== false, models: providerModels(p), apiKey: '' };
};
const fresh = (ark: boolean): ProviderInput => ({ id: crypto.randomUUID(), name: ark ? t("火山方舟 Coding Plan") : '', kind: ark ? 'anthropic' : 'openai',
  baseUrl: ark ? ARK_ANTHROPIC_URL : '', model: ark ? 'ark-code-latest' : '', contextWindow: 32768, maxTokens: 4096, enabled: true, apiKey: '',
  models: [{ id: ark ? 'ark-code-latest' : '', contextWindow: 32768, maxTokens: 4096, enabled: true }] });

export default function ModelSettings({ settings, health, onHealth, healthPending, onSaved }: {
  settings: AppSettings; health: ModelHealth; onHealth: () => Promise<void>; healthPending: boolean; onSaved: () => Promise<unknown>;
}) {
  useLocale();
  const [form, setForm] = useState<ProviderInput>(() => fromProvider(settings.providers[0]));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [startingService, setStartingService] = useState(false);
  const [inspection, setInspection] = useState<ModelHealth>();
  const [showKey, setShowKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const existing = settings.providers.find(p => p.id === form.id);
  const local = form.kind === 'ollama';
  const locked = busy || Boolean(testing) || inspecting || startingService;
  const localHealth = inspection ?? (dirty ? undefined : health);
  const models = form.models!;
  const reset = (next: ProviderInput) => { setForm(next); setDirty(!settings.providers.some(p => p.id === next.id)); setShowKey(false); setFeedback(''); setError(''); setConfirmDelete(false); setInspection(undefined); };
  const update = (patch: Partial<ProviderInput>) => { setForm(previous => ({ ...previous, ...patch })); setDirty(true); setFeedback(''); setError(''); setInspection(undefined); };
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
      await onSaved(); setForm(fromProvider(saved)); setDirty(false); setShowKey(false); setFeedback(local ? '本地配置已保存，仅影响后续任务。历史会话保留；未下载或启动任何模型服务。' : '设置已保存。可在输入框下方手动选择此模型。');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const test = async (modelId: string) => {
    setTesting(modelId); setError(''); setFeedback('');
    try { const result = await window.localcode.testProvider({ providerId: form.id, modelId }); setFeedback(result.message); }
    catch (e) { setError(errorText(e)); } finally { setTesting(''); }
  };
  const inspect = async () => {
    setInspecting(true); setError(''); setFeedback('');
    try {
      setInspection(await window.localcode.inspectLocalModel({ baseUrl: form.baseUrl.trim(), model: models[0].id.trim(), contextWindow: models[0].contextWindow, ollamaMode: form.ollamaMode }));
    } catch (e) { setError(errorText(e)); } finally { setInspecting(false); }
  };
  const startService = async () => {
    setStartingService(true); setError(''); setFeedback('');
    try { setInspection(await window.localcode.startLocalService()); await onHealth(); }
    catch (e) { setError(errorText(e)); } finally { setStartingService(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await window.localcode.deleteProvider(form.id); await onSaved(); reset(fromProvider(settings.providers.find(p => p.kind === 'ollama')!)); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <div className="model-settings">
    <div className="model-settings-heading"><div className="settings-section-heading"><h3>{t("模型设置")}</h3><p>{t("本地模型或云端 API 二选一即可。仅用云端时，无需安装 Ollama、显卡环境或下载模型。")}</p></div><button className="primary-button" disabled={locked} onClick={() => reset(fresh(true))}><Plus size={15} />{t("添加供应商")}</button></div>
    <div className="provider-workspace">
      <aside className="provider-list"><span className="provider-group-label">{t("本地模型")}</span>{settings.providers.filter(p => p.kind === 'ollama').map(p => <button key={p.id} disabled={locked} className={form.id === p.id ? 'active' : ''} onClick={() => reset(fromProvider(p))}><Cpu size={16} /><span>{providerLabel(p)}</span><i className={`status-dot ${health.online && health.modelAvailable ? 'online' : 'offline'}`} /></button>)}
        <span className="provider-group-label">{t("自定义供应商")}</span>{settings.providers.filter(p => p.kind !== 'ollama').map(p => <button key={p.id} disabled={locked} className={form.id === p.id ? 'active' : ''} onClick={() => reset(fromProvider(p))}><Box size={16} /><span>{providerLabel(p)}</span><i className={`status-dot ${p.enabled !== false && p.hasKey && providerModels(p).some(m => m.enabled) ? 'online' : 'offline'}`} /></button>)}
        {!existing && <button className="active" disabled><Box size={16} /><span>{providerLabel(form) || t("新供应商")}</span><small>{t("草稿")}</small></button>}
        <div className="provider-presets"><span className="provider-group-label">{t("快速配置")}</span><button disabled={locked} onClick={() => reset(fresh(true))}><Zap size={15} />{t("火山 Coding Plan")}</button><button disabled={locked} onClick={() => reset(fresh(false))}><Plus size={15} />{t("自定义 API")}</button></div>
        <p className="provider-list-note">{t("状态圆点表示配置已启用。连通性以手动测试结果为准。")}</p>
      </aside>
      <form className="provider-form provider-detail" onSubmit={event => void save(event)}>
        <div className="provider-detail-heading"><Box size={21} /><strong>{providerLabel(form) || t("新供应商")}</strong>{dirty && <small>{t("未保存")}</small>}<label className="provider-switch"><input aria-label={t("启用供应商")} type="checkbox" checked={form.enabled !== false} disabled={locked} onChange={e => update({ enabled: e.target.checked })} /><span /></label></div>
        {local && <>
          <div className="connection-card" role="status" aria-live="polite"><Cpu size={17} /><div><strong>{localHealth?.modelAvailable ? t("本地模型已安装") : dirty && !inspection ? t("配置已修改，尚未检查") : t("本地模型检查")}</strong><p>{(localHealth?.message && t(localHealth.message)) || t("检查仅读取已安装模型列表，不加载、下载或生成内容。")}</p></div><button type="button" className="icon-button" aria-label={t("检查本地模型和服务")} onClick={() => void inspect()} disabled={locked || healthPending}><RefreshCw size={15} className={inspecting ? 'spin' : ''} /></button></div>
          <label className="field"><span>{t("Ollama 服务来源")}</span><select aria-label={t("Ollama 服务来源")} value={form.ollamaMode ?? 'managed'} disabled={locked} onChange={e => update({ ollamaMode: e.target.value as 'managed' | 'existing', ...(e.target.value === 'managed' ? { baseUrl: MANAGED_OLLAMA_URL } : {}) })}><option value="managed">{t("本套安装的 Ollama")}</option><option value="existing">{t("使用我已有的 Ollama（仅本机）")}</option></select></label>
          <p className="profile-note">{form.ollamaMode === 'existing' ? t("仅连接你明确选择的本机服务。请自行启动 Ollama，填写地址，然后检查已安装模型；应用不会启动、停止或修改此服务。") : t("本套服务仅在你点击启动时运行，不会自动占用其他 Ollama 的端口。未安装时，便携版运行 Install-LocalModel.cmd；源码版运行 Setup.cmd。")}</p>
          {form.ollamaMode !== 'existing' && <button type="button" className="secondary-button" disabled={locked || dirty} onClick={() => void startService()}>{startingService ? <LoaderCircle size={14} className="spin" /> : <Cpu size={14} />}{t("启动本套 Ollama")}</button>}
        </>}
        <fieldset disabled={locked} className="provider-fields">
          <label className="field"><span>{t("供应商名称")}</span><input aria-label={t("供应商名称")} required maxLength={80} value={providerLabel(form)} placeholder={t("例如：火山方舟")} onChange={e => update({ name: e.target.value })} /></label>
          <label className="field"><span>Base URL</span><input aria-label="Base URL" type="url" required disabled={local && form.ollamaMode !== 'existing'} value={form.baseUrl} placeholder="https://api.example.com/v1" onChange={e => update({ baseUrl: e.target.value })} spellCheck={false} /></label>
          <label className="field"><span>{t("API 格式")}</span><select aria-label={t("API 格式")} disabled={local} value={form.kind} onChange={e => changeKind(e.target.value as ProviderInput['kind'])}>{local && <option value="ollama">{t("本地 Ollama")}</option>}<option value="anthropic">Anthropic Messages (/v1/messages)</option><option value="openai">OpenAI Chat Completions (/chat/completions)</option><option value="responses">OpenAI Responses (/responses)</option></select></label>
          {!local && <label className="field"><span>API Key{existing?.hasKey && <em>{t("已加密保存")}</em>}</span><div className="api-key-input"><input aria-label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" maxLength={4096} value={form.apiKey || ''} placeholder={existing?.hasKey ? t("留空保留现有密钥") : t("输入 API Key")} onChange={e => update({ apiKey: e.target.value })} spellCheck={false} /><button className="icon-button" type="button" aria-label={showKey ? t("隐藏输入的密钥") : t("显示输入的密钥")} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><small>{t("使用 Windows 加密存储。已保存的密钥不会回传到界面。")}</small></label>}
        </fieldset>
        {!local && form.baseUrl.includes('ark.cn-beijing.volces.com') && <p className="profile-note">{t("Coding Plan：Anthropic 使用 /api/coding，OpenAI 使用 /api/coding/v3。模型可填 ark-code-latest，跟随方舟控制台选择。上下文与输出上限请按实际模型调整。")}</p>}
        {local && <div className="local-model-discovery"><button type="button" className="secondary-button" disabled={locked} onClick={() => void inspect()}>{inspecting ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{t("检查服务并列出已安装模型")}</button>{Boolean(localHealth?.installedModels?.length) && <label className="field"><span>{t("选择已安装模型")}</span><select aria-label={t("选择已安装模型")} disabled={locked} value={localHealth?.installedModels?.includes(models[0].id) ? models[0].id : ''} onChange={e => updateModel(0, { id: e.target.value })}><option value="" disabled>{t("选择一个模型，或在下方填写名称")}</option>{localHealth?.installedModels?.map(name => <option key={name} value={name}>{name}</option>)}</select></label>}</div>}
        <div className="model-list-heading"><strong>{t("模型列表")}</strong>{!local && <button type="button" className="secondary-button" disabled={locked} onClick={() => update({ models: [...models, { id: '', contextWindow: 32768, maxTokens: 4096, enabled: true }] })}><Plus size={14} />{t("添加模型")}</button>}</div>
        <div className="configured-models">{models.map((m, index) => <div className="configured-model" key={index}>
          <div className="configured-model-heading"><label className="field"><span>{t("模型 ID")}</span><input aria-label={index === 0 ? t("模型 ID") : t("模型 ID {number}", { number: index + 1 })} required maxLength={200} disabled={locked} value={m.id} placeholder={local ? t("例如：qwen3.5:4b") : 'ark-code-latest'} onChange={e => updateModel(index, { id: e.target.value })} spellCheck={false} /></label>
            {!local && <><button type="button" className="icon-button" title={t("测试连接（会发送一次少量模型请求）")} aria-label={t("测试模型 {number}", { number: index + 1 })} disabled={locked || dirty || !existing?.hasKey || form.enabled === false || !m.enabled} onClick={() => void test(m.id)}>{testing === m.id ? <LoaderCircle size={16} className="spin" /> : <Unplug size={16} />}</button><button type="button" className="icon-button" aria-label={t("删除模型 {number}", { number: index + 1 })} disabled={locked || models.length === 1} onClick={() => update({ models: models.filter((_, i) => i !== index) })}><Trash2 size={16} /></button><label className="provider-switch"><input type="checkbox" aria-label={t("启用模型 {number}", { number: index + 1 })} checked={m.enabled} disabled={locked} onChange={e => updateModel(index, { enabled: e.target.checked })} /><span /></label></>}
          </div>
          <div className="form-two-columns"><label className="field"><span>{t("上下文窗口（tokens）")}</span><input aria-label={index === 0 ? t("上下文窗口") : t("上下文窗口 {number}", { number: index + 1 })} type="number" min={2048} max={2097152} required disabled={locked} value={m.contextWindow} onChange={e => updateModel(index, { contextWindow: Number(e.target.value) })} /></label><label className="field"><span>{t("单次输出上限（tokens）")}</span><input aria-label={index === 0 ? t("单次输出上限") : t("单次输出上限 {number}", { number: index + 1 })} type="number" min={128} max={131072} required disabled={locked} value={m.maxTokens} onChange={e => updateModel(index, { maxTokens: Number(e.target.value) })} /></label></div>
          <label className="model-image-capability"><input type="checkbox" aria-label={t("支持图片输入 {number}",{number:index+1})} checked={Boolean(m.supportsImages ?? form.supportsImages)} disabled={local || locked} onChange={event => updateModel(index, { supportsImages: event.target.checked })} /><span>{t("支持图片输入")}<small>{local ? t("本地模型图片能力由应用检测。") : t("请按供应商的模型能力填写；未启用时不能发送图片。")}</small></span></label>
        </div>)}</div>
        {error && <div className="form-feedback error" role="alert"><AlertCircle size={15} />{t(error)}</div>}{feedback && <div className="form-feedback success" role="status"><Check size={15} />{t(feedback)}</div>}
        {local && <p className="profile-note">{t("这里的上下文是应用输入预算，不会修改 Ollama 的 num_ctx；请勿高于所选模型在服务中的实际上下文。输出上限只影响后续任务，不改变模型文件或历史。小内存设备可先用 4096 / 512；模型越大、上下文越长，内存需求越高。输出上限加 1536 必须小于上下文；模型需支持工具调用。")}</p>}
        <><p className="provider-test-note">{local ? t("保存不会下载模型或启动服务。检查只读取本机信息，不会发送推理请求。") : t("保存无需本地环境，也不会调用云端 API。保存后点击插头测试会发送少量请求并消耗对应额度。")}</p><div className="provider-form-footer">{!local && <button type="button" className="secondary-button" disabled={!existing || locked} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />{t("删除供应商")}</button>}<button type="submit" className="primary-button" disabled={locked || !dirty}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{t("保存配置")}</button></div><small className="provider-security-note"><ShieldCheck size={12} />{t("保存后在聊天输入框下方选择供应商和模型。")}</small></>
        {confirmDelete && <div className="provider-delete-confirm"><p>{t('删除“{name}”及其密钥？历史会话会保留。', { name: form.name })}</p><button type="button" className="secondary-button" disabled={locked} onClick={() => setConfirmDelete(false)}>{t("取消")}</button><button type="button" className="primary-button" disabled={locked} onClick={() => void remove()}>{t("确认删除供应商")}</button></div>}
      </form>
    </div>
  </div>;
}
