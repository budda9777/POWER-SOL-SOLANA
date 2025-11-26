const { contextBridge, ipcRenderer } = require('electron');

// Espone le API in modo sicuro al renderer process
contextBridge.exposeInMainWorld('powersol', {
    // Bot control
    startBot: () => ipcRenderer.invoke('start-bot'),
    stopBot: () => ipcRenderer.invoke('stop-bot'),
    getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
    selfTest: async () => {
        try {
            const status = await ipcRenderer.invoke('get-bot-status');
            return { ok: true, status };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    },
    
    // Settings management
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    // Low-level command channel to backend
    sendCommand: (payload) => ipcRenderer.invoke('send-command', payload),

    // Trading actions
    sellPosition: (symbol) => ipcRenderer.invoke('sell-position', symbol),
    snipeToken: (payload) => ipcRenderer.invoke('snipe-token', payload),
    getTradeHistory: (limit=200) => ipcRenderer.invoke('get-trade-history', limit),
    
    // Event listeners
    onBotLog: (callback) => {
        const subscription = (event, data) => callback(data);
        ipcRenderer.on('bot-log', subscription);
        return () => ipcRenderer.removeListener('bot-log', subscription);
    },
    
    onBotData: (callback) => {
        const subscription = (event, data) => callback(data);
        ipcRenderer.on('bot-data', subscription);
        return () => ipcRenderer.removeListener('bot-data', subscription);
    },
    
    // Token events
    onTokenFound: (callback) => {
        const subscription = (event, token) => callback(token);
        ipcRenderer.on('token-found', subscription);
        return () => ipcRenderer.removeListener('token-found', subscription);
    }
});