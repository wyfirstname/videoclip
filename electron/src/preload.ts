import { contextBridge, ipcRenderer } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  onProgress: (callback: (event: { channel: string } & Record<string, unknown>) => void) => {
    const listener = (_e: unknown, event: { channel: string } & Record<string, unknown>) =>
      callback(event)
    ipcRenderer.on('progress-event', listener)
    return () => ipcRenderer.removeListener('progress-event', listener)
  }
}

contextBridge.exposeInMainWorld('vclip', api)

export type VclipApi = typeof api
