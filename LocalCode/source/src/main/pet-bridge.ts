import { contextBridge, ipcRenderer } from 'electron';
import type { PetApi, PetSnapshot } from '../shared/pets';
const invoke = (method: string, argument?: unknown) => ipcRenderer.invoke('localcode:pet', method, argument);
const api: PetApi = {
  state: () => invoke('state'), save: input => invoke('save', input), action: action => invoke('action', action),
  importAtlas: id => invoke('import', id), interactive: value => invoke('interactive', value),
  create: input => invoke('create', input), refresh: () => invoke('refresh'), remove: id => invoke('remove', id),
  drag: input => invoke('drag', input),
  onState: listener => { const handler = (_event: Electron.IpcRendererEvent, state: PetSnapshot) => listener(state); ipcRenderer.on('localcode:pet-state', handler); return () => ipcRenderer.removeListener('localcode:pet-state', handler); },
};
contextBridge.exposeInMainWorld('localpets', api);
