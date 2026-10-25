import { contextBridge, ipcRenderer } from 'electron';
import './pet-bridge';
import type { AppEvent, LocalCodeApi } from '../shared/contracts';
const invoke = (method: string, argument?: unknown) => ipcRenderer.invoke('localcode:invoke', method, argument);
const api: LocalCodeApi = {
  setLocale: locale => invoke('setLocale', locale),
  bootstrap: () => invoke('bootstrap'), pickProject: () => invoke('pickProject'),
  createSession: id => invoke('createSession', id), openSession: id => invoke('openSession', id), renameSession: input => invoke('renameSession', input),
  send: input => invoke('send', input), stop: id => invoke('stop', id), approve: input => invoke('approve', input),
  listFiles: input => invoke('listFiles', input), readFile: input => invoke('readFile', input), changes: id => invoke('changes', id), undo: input => invoke('undo', input),
  previewCheckpoint: input => invoke('previewCheckpoint', input), checkpoint: input => invoke('checkpoint', input),
  artifactInfo: input => invoke('artifactInfo', input), artifactAction: input => invoke('artifactAction', input),
  openExternal: url => invoke('openExternal', url),
  saveProvider: input => invoke('saveProvider', input), deleteProvider: id => invoke('deleteProvider', id), testProvider: input => invoke('testProvider', input), setTheme: theme => invoke('setTheme', theme), setFontSize: fontSize => invoke('setFontSize', fontSize), health: () => invoke('health'), inspectLocalModel: input => invoke('inspectLocalModel', input), startLocalService: () => invoke('startLocalService'), openDataFolder: () => invoke('openDataFolder'),
  onEvent: listener => { const handler = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value); ipcRenderer.on('localcode:event', handler); return () => ipcRenderer.removeListener('localcode:event', handler); },
};
contextBridge.exposeInMainWorld('localcode', api);
