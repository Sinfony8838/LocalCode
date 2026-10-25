import type { ArtifactInfo, ArtifactAction, ArtifactInputKind } from './artifacts';
import type { AppLocale } from './i18n';
export type RunStatus = 'idle' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'interrupted';
export type Theme = 'light' | 'dark';
export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface MessagePart { index: number; type: 'text' | 'thinking'; text: string; startedAt: string; endedAt?: string; state: 'streaming' | 'completed' | 'interrupted' }
export interface RunProgress { phase: 'waiting' | 'thinking' | 'output' | 'tool' | 'queued' | 'retry'; since: string; retryAt?: number; attempt?: number }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; runId?: string; partial?: boolean; parts?: MessagePart[] }
export interface RunFileChange { path: string; kind: 'created' | 'modified' | 'deleted'; additions: number | null; deletions: number | null; source: 'file_tool' | 'workspace'; conflict?: boolean }
export interface RunSummary { runId: string; startedAt: string; endedAt?: string; durationMs?: number; status: 'running' | 'completed' | 'failed' | 'interrupted'; finalMessageId?: string; changes: RunFileChange[]; changeScope: 'workspace_snapshot' | 'file_tools'; coverageNote?: string; changesError?: string }
export interface ToolRecord { id: string; runId: string; name: string; args: unknown; result?: string; isError?: boolean; status: 'running' | 'completed' | 'failed'; createdAt: string }
export interface Approval { id: string; runId: string; sessionId: string; command: string; cwd: string }
export interface SessionView { id: string; projectId: string; title: string; createdAt: string; updatedAt: string; providerId: string; modelId?: string; piFile?: string; status: RunStatus; runId?: string; runs?: RunSummary[]; messages: ChatMessage[]; tools: ToolRecord[]; approval?: Approval; error?: string; progress?: RunProgress }
export interface ModelConfig { id: string; contextWindow: number; maxTokens: number; enabled: boolean }
export interface ProviderConfig { id: string; name: string; kind: 'ollama' | 'openai' | 'anthropic' | 'responses'; baseUrl: string; model: string; contextWindow: number; maxTokens: number; hasKey: boolean; enabled?: boolean; models?: ModelConfig[]; ollamaMode?: 'managed' | 'existing' }
export interface ProviderSecret extends ProviderConfig { apiKey: string }
export interface AppSettings { theme: Theme; fontSize: number; locale: AppLocale; defaultProviderId: string; providers: ProviderConfig[] }
export interface LocalModelProbe { baseUrl: string; model: string; contextWindow: number; ollamaMode?: 'managed' | 'existing' }
export interface ModelHealth { status?: 'ready' | 'offline' | 'missing_model' | 'invalid_response' | 'invalid_config' | 'unverified_service' | 'missing_runtime'; installedModels?: string[]; online: boolean; modelAvailable: boolean; model: string; contextWindow: number; version?: string; gpuPercent?: number; message?: string }
export interface FileEntry { path: string; name: string; directory: boolean }
export interface FileView { path: string; content: string; truncated: boolean }
export interface ChangeCheckpointPreview { path: string; content: string; currentHash: string; recordHash: string; byteLength: number }
export interface ChangeView { path: string; before: string; after: string; created: boolean; conflict: boolean; runId: string }
export interface Bootstrap { projects: Project[]; sessions: SessionView[]; settings: AppSettings; health: ModelHealth; version: string }
export type AgentEvent = { runId: string; sessionId: string; recordedAt?: string } & (
 | { type: 'status'; status: RunStatus }
 | { type: 'message_start'; messageId: string }
 | { type: 'text_delta'; messageId: string; delta: string }
 | { type: 'part_start'; messageId: string; index: number; kind: 'text' | 'thinking'; at: string }
 | { type: 'part_delta'; messageId: string; index: number; delta: string }
 | { type: 'part_end'; messageId: string; index: number; at: string; interrupted?: boolean; text?: string }
 | { type: 'progress'; progress: RunProgress }
 | { type: 'message_end'; messageId: string; text: string }
 | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
 | { type: 'tool_result'; toolCallId: string; result: string; isError: boolean }
 | { type: 'approval'; approval: Approval }
 | { type: 'approval_resolved'; approvalId: string }
 | { type: 'changes_updated' }
 | { type: 'session_file'; file: string }
 | { type: 'error'; message: string }
 | { type: 'settled'; status: 'completed' | 'failed' | 'interrupted'; error?: string; summary?: RunSummary }
 | { type: 'notice'; message: string }
);
export interface RunRequest { type: 'run'; runId: string; sessionId: string; projectPath: string; dataDir: string; piFile?: string; provider: ProviderSecret; prompt: string; locale?: AppLocale }
export type WorkerCommand = RunRequest | { type: 'approve'; runId: string; approvalId: string; allow: boolean } | { type: 'abort'; runId: string } | { type: 'shutdown' };
export type TransportMessage = { runId: string; sessionId: string; requestId: string } & ({ type: 'request_acquire' } | { type: 'request_release'; cooldownUntil?: number } | { type: 'request_cancel' });
export type TransportGrant = { type: 'request_grant'; runId: string; requestId: string };
export type AppEvent = AgentEvent | { type: 'state_changed' };
export interface LocalCodeApi {
 openExternal(url: string): Promise<void>;
 bootstrap(): Promise<Bootstrap>;
 pickProject(): Promise<Project | null>;
 createSession(projectId: string): Promise<SessionView>;
 openSession(sessionId: string): Promise<SessionView>;
 renameSession(input: {sessionId: string; title: string}): Promise<SessionView>;
 send(input: {sessionId: string; prompt: string; providerId: string; modelId?: string}): Promise<{runId: string}>;
 stop(sessionId: string): Promise<void>;
 approve(input: {runId: string; approvalId: string; allow: boolean}): Promise<void>;
 listFiles(input: {projectId: string; directory?: string}): Promise<FileEntry[]>;
 readFile(input: {projectId: string; path: string}): Promise<FileView>;
 artifactInfo(input: {projectId: string; path: string; inputKind?: ArtifactInputKind}): Promise<ArtifactInfo>;
 artifactAction(input: {projectId: string; path: string; action: ArtifactAction; inputKind?: ArtifactInputKind}): Promise<void>;
 changes(sessionId: string): Promise<ChangeView[]>;
 previewCheckpoint(input: {sessionId: string; path: string}): Promise<ChangeCheckpointPreview>;
 checkpoint(input: {sessionId: string; path: string; expectedHash: string; expectedRecordHash: string}): Promise<void>;
 undo(input: {sessionId: string; path: string}): Promise<void>;
 saveProvider(input: Omit<ProviderConfig, 'hasKey'> & {apiKey?: string}): Promise<ProviderConfig>;
 deleteProvider(providerId: string): Promise<void>;
 testProvider(input: {providerId: string; modelId?: string}): Promise<{message: string}>;
 setTheme(theme: Theme): Promise<void>;
 setLocale(locale: AppLocale): Promise<void>;
 setFontSize(fontSize: number): Promise<void>;
 health(): Promise<ModelHealth>;
 inspectLocalModel(input: LocalModelProbe): Promise<ModelHealth>;
 startLocalService(): Promise<ModelHealth>;
 openDataFolder(): Promise<void>;
 onEvent(listener: (event: AppEvent) => void): () => void;
}
declare global { interface Window { localcode: LocalCodeApi } }
