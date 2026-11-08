import { contextBridge, ipcRenderer } from 'electron';
import { INSTALLER_CHANNELS } from './policy';

contextBridge.exposeInMainWorld('extaliaInstaller', Object.freeze({
  install: () => ipcRenderer.invoke(INSTALLER_CHANNELS.install),
  continue: () => ipcRenderer.invoke(INSTALLER_CHANNELS.continue),
}));
