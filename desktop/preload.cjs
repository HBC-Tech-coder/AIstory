// Electron sandboxed preload scripts use the restricted CommonJS loader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "aistoryDesktop",
  Object.freeze({
    getRuntimeInfo: () => ipcRenderer.invoke("aistory:runtime-info"),
    openExternal: (url) =>
      ipcRenderer.invoke("aistory:open-external", String(url || "")),
    requestSoftKeyboard: (bounds) =>
      ipcRenderer.invoke("aistory:soft-keyboard", {
        x: Number(bounds?.x) || 0,
        y: Number(bounds?.y) || 0,
        width: Number(bounds?.width) || 0,
        height: Number(bounds?.height) || 0,
        multiline: bounds?.multiline === true,
      }),
    setFullscreen: (enabled) =>
      ipcRenderer.invoke("aistory:set-fullscreen", enabled === true),
    toggleFullscreen: () => ipcRenderer.invoke("aistory:toggle-fullscreen"),
  }),
);
