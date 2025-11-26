// === SOLANA SNIPER BOT DASHBOARD ===
// Execution marker (diagnostic)
try { window.__rendererLoadedAt = Date.now(); console.log('[renderer] load marker set'); } catch(_){ }

// === NOTIFICATION MANAGER (toasts + optional system notifications) ===
// Lightweight, no external deps. Types: info | success | warning | error
let __toastContainer = null;
const __toastDefaults = { life: 5200, pauseOnHover: true };
function ensureToastContainer(){
    if (__toastContainer) return __toastContainer;
    const div = document.createElement('div');
    div.className = 'toast-container';
    document.body.appendChild(div);
    __toastContainer = div;
    return div;
}
function requestSystemNotificationPermission(){
    try {
        if (window.Notification && Notification.permission === 'default') {
            Notification.requestPermission().catch(()=>{});
        }
    } catch(_){ }
}
function emitSystemNotification(title, body){
    try {
        if (!window.Notification) return;
        if (Notification.permission === 'granted') {
            new Notification(title, { body });
        }
    } catch(_){ }
}
function showNotification(opts){
    try {
        const { title='Notification', message='', type='info', life=__toastDefaults.life, system=false, meta='' } = opts||{};
        const container = ensureToastContainer();
        const id = 't_'+Math.random().toString(36).slice(2);
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.setAttribute('data-id', id);
        toast.innerHTML = `
            <button class="toast-close" aria-label="close">✕</button>
            <h4>${title}</h4>
            <div class="toast-body">${message}</div>
            ${meta?`<div class="toast-meta">${meta}</div>`:''}
            <progress class="toast-life" max="100" value="100"></progress>`;
        container.appendChild(toast);
        let remaining = life;
        const started = Date.now();
        const bar = toast.querySelector('progress.toast-life');
        let paused = false;
        let frame;
        function step(){
            if (paused) { frame = requestAnimationFrame(step); return; }
            const elapsed = Date.now() - started;
            const pct = Math.max(0, 100 - (elapsed/ life)*100);
            if (bar) bar.value = pct;
            if (elapsed >= life) { dismiss(); return; }
            frame = requestAnimationFrame(step);
        }
        function dismiss(){
            cancelAnimationFrame(frame);
            toast.classList.add('toast-leaving');
            setTimeout(()=>{ toast.remove(); }, 450);
        }
        toast.querySelector('.toast-close').addEventListener('click', dismiss);
        if (__toastDefaults.pauseOnHover) {
            toast.addEventListener('mouseenter', ()=>{ paused = true; });
            toast.addEventListener('mouseleave', ()=>{ paused = false; });
        }
        frame = requestAnimationFrame(step);
        // Optional system notification mirror
        if (system) emitSystemNotification(title, message.replace(/<[^>]+>/g,'').slice(0,180));
        return { id, dismiss };
    } catch(err){ console.error('showNotification error', err); }
}

// Convenience helpers
const notify = {
    info:(msg,opts)=>showNotification({ title:'INFO', message:msg, type:'info', ...opts }),
    success:(msg,opts)=>showNotification({ title:'SUCCESS', message:msg, type:'success', ...opts }),
    warning:(msg,opts)=>showNotification({ title:'WARNING', message:msg, type:'warning', ...opts }),
    error:(msg,opts)=>showNotification({ title:'ERROR', message:msg, type:'error', ...opts })
};

// Request notification permission early (non-blocking)
requestSystemNotificationPermission();

// === ENHANCED TOAST MANAGER (dedupe + updating chain toasts + PnL milestones) ===
// Rationale: previous implementation emitted many near-identical toasts (sell_result, position_closed,
// position_update milestone, etc). This manager creates keyed toasts that get UPDATED instead of duplicated.
// Keys: snipe:<requestId|symbol>, sell:<requestId|symbol>, posopen:<symbol>, posclose:<symbol>, pnl:<symbol>
class ToastManager {
    constructor(){
    this.toasts = new Map(); // key -> { id, dismiss, lastHash, lastUpdate }
    // milestone PnL tracking disabled (simplified per user requests)
    this.minUpdateIntervalMs = 300; // throttle aggiornamenti (meno conservativo per RT feedback)
    }
    _hash(obj){ return JSON.stringify(obj); }
    _createOrUpdate(key, payload){
        const now = Date.now();
        const existing = this.toasts.get(key);
        const { title, message, type='info', life=5200, meta='', system=false } = payload;
        const hash = this._hash({title,message,type,meta});
        if (existing) {
            if (existing.lastHash === hash && (now - existing.lastUpdate) < this.minUpdateIntervalMs) {
                // Duplicate within throttle window -> ignore
                return existing;
            }
            // Update DOM content instead of creating new toast
            try {
                const el = document.querySelector(`.toast[data-id="${existing.id}"]`);
                if (el) {
                    const h4 = el.querySelector('h4'); if (h4) h4.innerHTML = title;
                    const body = el.querySelector('.toast-body'); if (body) body.innerHTML = message;
                    const metaDiv = el.querySelector('.toast-meta');
                    if (meta) {
                        if (metaDiv) metaDiv.innerHTML = meta; else {
                            const m = document.createElement('div'); m.className='toast-meta'; m.innerHTML = meta; el.appendChild(m); }
                    } else if (metaDiv) metaDiv.remove();
                    el.classList.add('toast-updated');
                    setTimeout(()=> el && el.classList.remove('toast-updated'), 600);
                }
                existing.lastHash = hash;
                existing.lastUpdate = now;
            } catch(err){ console.warn('[ToastManager] update failed', err); }
            return existing;
        }
        const created = showNotification({ title, message, type, life, meta, system });
        if (created) {
            this.toasts.set(key, { ...created, lastHash: hash, lastUpdate: now });
            // Auto cleanup on life expiry (best-effort)
            setTimeout(()=>{ if (this.toasts.get(key)?.id === created.id) this.toasts.delete(key); }, life+1200);
        }
        return created;
    }
    dismiss(key){ const t = this.toasts.get(key); if (t) { try { t.dismiss(); } catch(_){} this.toasts.delete(key); } }
    dismissByPrefix(prefix){ for (const k of Array.from(this.toasts.keys())) if (k.startsWith(prefix)) this.dismiss(k); }
    snipeProgress(data){
        const r = data.result || data;
        const key = 'snipe:' + (r.requestId || r.symbol || 'unknown');
        let type = 'info';
        let title = 'SNIPE';
        let message = '';
        if (r.error) { type='error'; title='SNIPE FAIL'; message = `${r.symbol||''} ${r.error}`; this._createOrUpdate(key,{title,message,type,life:7000}); return; }
        switch(r.status){
            case 'LOOKUP': title='SNIPE LOOKUP'; message=`Searching ${r.symbol||''}…`; break;
            case 'LOOKUP_OK': title='SNIPE FOUND'; type='success'; message=`${r.symbol||''} token ok`; break;
            case 'EXECUTING': title='SNIPE EXEC'; message=`Executing ${r.symbol||''}`; break;
            case 'SUBMITTED': title='SNIPE TX'; message=`Tx submitted ${r.symbol||''}`; break;
            case 'DONE': title='SNIPE DONE'; type='success'; message=`${r.symbol||''} purchased`; break;
            default: message = `${r.symbol||''} status ${r.status}`;
        }
        this._createOrUpdate(key,{ title, message, type, life: r.status==='DONE'?6000:4200 });
        if (r.status === 'DONE') setTimeout(()=> this.dismiss(key), 6500);
    }
    sellProgress(data){
        const r = data.result || data;
            const key = 'sell:' + (r.requestId || r.symbol || 'unknown');
        let type='info', title='SELL', message='';
        if (r.error){ type='error'; title='SELL FAIL'; message=`${r.symbol||''} ${r.error}`; }
    else if (r.status==='EXECUTING'){ message=`Executing sell ${r.symbol}`; }
    else if (r.status==='SUBMITTED'){ title='SELL TX'; message=`Tx submitted ${r.symbol}`; }
    else if (r.status==='DONE'){ type='success'; title='SELL OK'; message=`${r.symbol} sold`; }
        else { message=`${r.symbol||''} stato ${r.status||'?'}`; }
        this._createOrUpdate(key,{title,message,type,life: r.status==='DONE'?5000:4000});
        if (r.status==='DONE' || r.error) setTimeout(()=> this.dismiss(key), 5200);
    }
    positionOpened(p){
        if (!p?.symbol) return;
        const key = 'posopen:'+p.symbol;
            const amount = p.amountSol || p.amount || p.tokenAmount || p.scaledTokenAmount || '';
        const msg = `Entry ${p.symbol} @ ${formatAdaptivePrice(p.entryPrice||0)}${amount?` • qty ${amount}`:''}`;
    this._createOrUpdate(key,{ title:'POSITION OPENED', message:msg, type:'success', life:6000 });
    }
    positionClosed(p){
        if (!p?.symbol) return;
        const key = 'posclose:'+p.symbol;
            const pnlPct = (p.pnlPercent!=null)?p.pnlPercent:(p.entryPrice?((p.exitPrice||p.currentPrice||0)/(p.entryPrice)-1)*100:0);
        const pnlUsd = p.pnlUsd!=null?p.pnlUsd:(p.pnl!=null?p.pnl:0);
        const type = pnlUsd>=0?'success':'error';
        const msg = `${p.symbol} ${pnlUsd>=0?'+':''}${formatCurrency(pnlUsd)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)`;
    this._createOrUpdate(key,{ title:'POSITION CLOSED', message:msg, type, life:7000 });
        // Clean milestone toasts
        this.dismissByPrefix('pnl:'+p.symbol);
    }
    positionUpdate(_p){ /* milestone toasts disabilitati su richiesta utente */ }
}
const toastManager = new ToastManager();

// === TAB BADGE MANAGER ===
class BadgeManager {
    constructor(){
        this.counts = new Map(); // tabId -> count
    }
    _ensure(tabId){
        const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        if (!btn) return null;
        let badge = btn.querySelector('.tab-badge');
        if (!badge){
            badge = document.createElement('span');
            badge.className = 'tab-badge';
            btn.appendChild(badge);
        }
        return { btn, badge };
    }
    increment(tabId, delta=1){
        const current = this.counts.get(tabId) || 0;
        this.counts.set(tabId, current + delta);
        this.render(tabId);
    }
    set(tabId, value){
        this.counts.set(tabId, value);
        this.render(tabId);
    }
    clear(tabId){
        if (!this.counts.has(tabId)) return;
        this.counts.set(tabId, 0);
        this.render(tabId);
    }
    render(tabId){
        const entry = this._ensure(tabId);
        if (!entry) return;
        const { btn, badge } = entry;
        const val = this.counts.get(tabId) || 0;
        if (val <= 0){
            btn.classList.remove('has-badge');
            badge.textContent='';
        } else {
            btn.classList.add('has-badge');
            badge.textContent = val > 99 ? '99+' : String(val);
        }
    }
    bumpForEvent(e){
        // Basic mapping: discovery (token_found), positions (position_opened/closed/update), history (position_closed), logs (error), dashboard (stats_update optional)
        switch(e){
            case 'token_found': this.increment('tab-discovery'); break;
            case 'position_opened': this.increment('tab-positions'); break;
            case 'position_closed': this.increment('tab-history'); this.increment('tab-positions'); break;
            case 'sell_result': this.increment('tab-history'); break;
            case 'snipe_result': this.increment('tab-discovery'); break;
            case 'log_error': this.increment('tab-logs'); break;
            default: break;
        }
    }
}
window.badgeManager = new BadgeManager();

// State Management
let botState = {
    isActive: false,
    startTime: null,
    positionEvents: 0,
    stats: { totalPnl: 0, tradesExecuted: 0, salesExecuted: 0 },
    foundTokens: new Map(),
    openPositions: new Map(),
    closedTrades: [],
    closedTradeKeys: new Set(), // dedupe keys for history entries
    priceHistory: new Map(),
    pnlHistory: [],
    recentExecutions: [],
    sortConfig: { key: null, direction: 'asc' },
    previousPositions: new Map() // symbol -> { pnlPercent, currentPrice }
};

// Price history cache (symbol -> [{t,p}]) for multi-interval deltas (5m/15m/30m)
const lastPriceCache = new Map();
// Retain ~32 minutes of data (enough for 30m window + slack)
const PRICE_HISTORY_RETENTION_MS = 32 * 60 * 1000;
// Discovery delta windows (minutes)
const DELTA_WINDOWS_MINUTES = [5,15,30]; // referenced in UI

// DOM Elements
const elements = {
    botSwitch: document.getElementById('botSwitch'),
    statusIndicator: document.getElementById('botStatus'),
    statusLabel: document.getElementById('statusLabel'),
    headerTotalPnl: document.getElementById('headerTotalPnl'),
    headerBotStatus: document.getElementById('headerBotStatus'),
    headerWalletBalance: document.getElementById('headerWalletBalance'),
    botRunButton: document.getElementById('botRunButton'),
    totalPnl: document.getElementById('totalPnl'),
    tradesExecuted: document.getElementById('tradesExecuted'),
    salesExecuted: document.getElementById('salesExecuted'),
    activePositions: document.getElementById('activePositions'),
    runtime: document.getElementById('runtime'),
    tokensTableBody: document.getElementById('tokensTableBody'),
    positionsTableBody: document.getElementById('positionsTableBody'),
    logContainer: document.getElementById('logContainer'),
    recentExecutions: document.getElementById('recentExecutions'),
    discoveryBody: document.getElementById('discoveryTokensBody'),
    tokenSearch: document.getElementById('tokenSearch'),
    discoverySafetyFilter: document.getElementById('discoverySafetyFilter'),
    foundTokenCount: document.getElementById('foundTokenCount'),
    positionsTableBodyFull: document.getElementById('positionsTableBodyFull'),
    openPositionsCount: document.getElementById('openPositionsCount'),
    logContainerFull: document.getElementById('logContainerFull'),
    logLevelFilter: document.getElementById('logLevelFilter'),
    clearLogs: document.getElementById('clearLogs'),
    rpcEndpoint: document.getElementById('rpcEndpoint'),
    maxPriorityFee: document.getElementById('maxPriorityFee'),
    slippage: document.getElementById('slippage'),
    autoSellProfit: document.getElementById('autoSellProfit'),
    stopLoss: document.getElementById('stopLoss'),
    PRIVATE_KEY: document.getElementById('PRIVATE_KEY'),
    MORALIS_API_KEY: document.getElementById('MORALIS_API_KEY'),
    HELIUS_API_KEY: document.getElementById('HELIUS_API_KEY'),
    BIRDEYE_API_KEY: document.getElementById('BIRDEYE_API_KEY'),
    SOLANA_RPC_PRIMARY: document.getElementById('SOLANA_RPC_PRIMARY'),
    SOLANA_RPC_SECONDARY: document.getElementById('SOLANA_RPC_SECONDARY'),
    SOLANA_RPC_TERTIARY: document.getElementById('SOLANA_RPC_TERTIARY'),
    TRADE_AMOUNT_SOL: document.getElementById('TRADE_AMOUNT_SOL'),
    MAX_POSITIONS: document.getElementById('MAX_POSITIONS'),
    MIN_SAFETY_SCORE: document.getElementById('MIN_SAFETY_SCORE'),
    MIN_VOLUME_24H: document.getElementById('MIN_VOLUME_24H'),
    MIN_HOLDERS: document.getElementById('MIN_HOLDERS'),
    MIN_LIQUIDITY: document.getElementById('MIN_LIQUIDITY'),
    TOKEN_AGE_HOURS_MIN: document.getElementById('TOKEN_AGE_HOURS_MIN'),
    TOKEN_AGE_HOURS_MAX: document.getElementById('TOKEN_AGE_HOURS_MAX'),
    SCAN_INTERVAL_SECONDS: document.getElementById('SCAN_INTERVAL_SECONDS'),
    MAX_TOKENS_PER_SCAN: document.getElementById('MAX_TOKENS_PER_SCAN'),
    MONITOR_INTERVAL: document.getElementById('MONITOR_INTERVAL'),
    PRICE_CACHE_SECONDS: document.getElementById('PRICE_CACHE_SECONDS'),
    ENABLE_SMART_CACHING: document.getElementById('ENABLE_SMART_CACHING'),
    STOP_LOSS_PERCENT: document.getElementById('STOP_LOSS_PERCENT'),
    TAKE_PROFIT_PERCENT: document.getElementById('TAKE_PROFIT_PERCENT'),
    TRAILING_STOP_TRIGGER: document.getElementById('TRAILING_STOP_TRIGGER'),
    TRAILING_STOP_PERCENT: document.getElementById('TRAILING_STOP_PERCENT'),
    FAST_SELL_ENABLED: document.getElementById('FAST_SELL_ENABLED'),
    PANIC_SELL_THRESHOLD: document.getElementById('PANIC_SELL_THRESHOLD'),
    // Rimossi: BACKUP_CACHE_DURATION, MAX_TOTAL_FEE_PERCENT, MAX_PRIORITY_FEE
    BUY_SLIPPAGE_BPS: document.getElementById('BUY_SLIPPAGE_BPS'),
    SELL_SLIPPAGE_BPS: document.getElementById('SELL_SLIPPAGE_BPS'),
    FEE_PERCENTAGE: document.getElementById('FEE_PERCENTAGE'),
    ENABLE_REAL_TRADES: document.getElementById('ENABLE_REAL_TRADES'),
    ENABLE_AUTO_TRADING: document.getElementById('ENABLE_AUTO_TRADING'),
    ENABLE_SELLS: document.getElementById('ENABLE_SELLS'),
    REQUIRE_VERIFIED_DATA: document.getElementById('REQUIRE_VERIFIED_DATA'),
    ENABLE_HONEYPOT_CHECK: document.getElementById('ENABLE_HONEYPOT_CHECK'),
    ALLOW_UNSAFE_MANUAL_SNIPE: document.getElementById('ALLOW_UNSAFE_MANUAL_SNIPE'),
    LOG_LEVEL: document.getElementById('LOG_LEVEL'),
    saveSettings: document.getElementById('saveSettings')
};

// Extra element references not originally in the mapped object
const closedTradesCount = document.getElementById('closedTradesCount');

// --- Safety stub: validateCriticalElements (was referenced but not defined) ---
function validateCriticalElements(){
    // Minimal check; expand if we want to enforce mandatory DOM nodes
    return true;
};

// (definitions moved earlier)

// First valid definition of stopBot (the one below remains the single active one)

// === INITIALIZATION ===
// All function implementations are defined in-order before initialize to avoid placeholder stubs.
// === BOT START / STOP (restored) ===
async function startBot() {
    if (botState.isActive) { addLog('info','ℹ️ Bot already running'); return; }
    const t0 = (performance?.now)?performance.now():Date.now();
    try {
        addLog('info','[startBot] ENTRY');
        updateBotStatus('starting');
        addLog('info','🚀 Starting Solana Sniper Bot...');
        if (!botState.isActive && botState.stats.totalPnl === 0 && botState.pnlHistory.length) botState.pnlHistory = [];
        let backendOk = false;
        let tBackendStart = null;
        if (window.powersol?.startBot) {
            const ts = (performance?.now)?performance.now():Date.now();
            try {
                const result = await window.powersol.startBot();
                const te = (performance?.now)?performance.now():Date.now();
                tBackendStart = te - ts;
                if (!result?.success) throw new Error(result?.error || 'Unknown start error');
                backendOk = true;
                addLog('success',`✅ Backend start acknowledged (${tBackendStart.toFixed(0)} ms)`);
            } catch(e){
                const te = (performance?.now)?performance.now():Date.now();
                addLog('warning',`⚠️ Backend start failed after ${(te-ts).toFixed(0)} ms: ${e.message} (continuing in demo)`);
            }
        } else {
            addLog('warning','⚠️ API startBot not available - Demo Mode');
        }
        botState.isActive = true;
        botState.startTime = Date.now();
        botState.positionEvents = 0;
        updateBotStatus('running');
        startRuntimeTimer();
        startPnlSnapshotTimer();
        snapshotPnl();
        refreshPnlChart();
        if (!backendOk) addLog('info','ℹ️ Demo Mode: no real trades will be executed');
        const t1 = (performance?.now)?performance.now():Date.now();
        addLog('success',`[startBot] EXIT ok (isActive=${botState.isActive}) total ${(t1-t0).toFixed(0)} ms`);
        try { notify.success('Bot started', { message:'The bot is running.', system:true }); } catch(_){ }
    } catch(e){
        updateBotStatus('error');
        const t1 = (performance?.now)?performance.now():Date.now();
        addLog('error',`❌ Start failed after ${(t1-t0).toFixed(0)} ms: ${e.message}`);
        addLog('error','[startBot] EXIT with error');
        try { notify.error('Start failed', { message:e.message }); } catch(_){ }
        throw e;
    }
}

// Check if bot backend is accessible
async function checkBotConnection() {
    try {
        if (window.powersol?.getBotStatus) {
            const status = await window.powersol.getBotStatus();
            if (status && (status.connected || status.running)) {
                addLog('success', `✅ Bot backend connected (PID: ${status.pid || 'n/a'}${status.version?`, v:${status.version}`:''})`);
                // If bot is running, ensure we render any existing positions
                renderPositionCards();
                return true;
            }
        }
        
        // If no backend connection, show warning but continue with demo mode
        addLog('warning', '⚠️ Bot backend not connected - Running in Demo Mode');
        addLog('info', '💡 To connect real bot: Configure .env file and restart');
        setupDemoData();
    schedulePositionsRender(); // Render demo positions
        return false;
        
    } catch (error) {
        addLog('warning', '⚠️ Bot backend not available - Demo Mode active');
        addLog('info', '💡 Start the application with: npm start');
        setupDemoData();
    schedulePositionsRender(); // Render demo positions on error
        return false;
    }
}

// === BOT CONTROL ===
function setupBotControl() {
    elements.botSwitch.addEventListener('change', async (e) => {
        const isChecked = e.target.checked;
        
        try {
            if (isChecked) {
                await startBot();
            } else {
                await stopBot();
            }
        } catch (error) {
            console.error('Bot control error:', error);
            e.target.checked = !isChecked;
            addLog('error', `❌ Bot control error: ${error.message}`);
        }
    });
    
    // Test connection button
    const testConnectionBtn = document.getElementById('testConnection');
        // Removed testConnection button and handler

    // Delegated listener per pulsanti SNIPE nel Radar
    const snipeCooldownMs = 2000;
    const pendingSnipe = new Map(); // symbol -> timestamp
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest && e.target.closest('.snipe-button');
        if (!btn) return;
    const symbol = btn.dataset.symbol;
    const address = btn.dataset.address;
    if (!symbol && !address) return;
        // Debounce per simbolo
        const now = Date.now();
        const last = pendingSnipe.get(symbol) || 0;
        if (now - last < snipeCooldownMs) {
            addLog('warning', `⏳ Please wait before repeating snipe on ${symbol}`);
            return;
        }
        if (!window.powersol?.snipeToken) {
            addLog('error', '❌ API snipeToken not available');
            return;
        }
        // Amount prompt + validazione
        let amount = null;
        if (!window.confirm('Use default amount (TRADE_AMOUNT_SOL)?\nCancel to specify a custom amount.')) {
            const user = window.prompt('Enter amount in SOL (e.g. 0.05):');
            if (user) {
                const v = parseFloat(user);
                if (!isNaN(v) && v > 0) amount = v; else addLog('warning','Invalid amount, using default');
            }
        }
        // Stato loading
        btn.disabled = true;
        btn.classList.add('loading');
        const origHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> SNIPE...';
    addLog('info', `🎯 Snipe requested: ${symbol||address}${amount?` @ ${amount} SOL`:''}`);
        pendingSnipe.set(symbol, now);
        try {
            const res = await window.powersol.snipeToken({ symbol, address, amount });
            if (res?.success) {
                addLog('success', `🚀 Snipe sent (${symbol}) requestId=${res.requestId}`);
                // Correlazione opzionale: salviamo ultimo requestId
                botState.lastSnipeRequest = { symbol, requestId: res.requestId, ts: Date.now(), amount: amount||'default' };
            } else {
                addLog('error', `❌ Snipe error (${symbol}): ${res?.error || 'unknown'}`);
                // Reset cooldown if it failed immediately
                pendingSnipe.delete(symbol);
            }
        } catch(err) {
            addLog('error', `❌ Exception snipe ${symbol}: ${err.message}`);
            pendingSnipe.delete(symbol);
        } finally {
            setTimeout(()=>{
                btn.disabled = false;
                btn.classList.remove('loading');
                btn.innerHTML = origHtml;
            }, 1200);
        }
    });
    
    // Settings button
    const settingsBtn = document.getElementById('settingsBtn');
        // Removed settings button and handler

    // Attempt to bind close button if panel exists (after open first time will rebind safely)
    const settingsClose = document.getElementById('settingsClose');
    if (settingsClose) settingsClose.addEventListener('click', closeSettings);

    if (elements.botRunButton) {
            elements.botRunButton.addEventListener('click', async () => {
                const state = elements.botRunButton.getAttribute('data-state');
                addLog('info',`[botRunButton] click (state=${state})`);
                try {
                    if (state === 'stopped') {
                        // Disclaimer gating
                        if (!localStorage.getItem('ps_disclaimer_ack')) {
                            const modal = document.getElementById('disclaimerModal');
                            if (modal) {
                                openDisclaimerModal();
                                return; // wait for user acceptance
                            }
                        }
                        elements.botRunButton.classList.add('starting');
                        await startBot();
                    } else if (state === 'running') {
                        elements.botRunButton.classList.add('stopping');
                        await stopBot();
                    }
                    addLog('info',`[botRunButton] post-action newState=${elements.botRunButton.getAttribute('data-state')}`);
                } finally {
                    elements.botRunButton.classList.remove('starting','stopping');
                }
            });
    }
}

// === SETTINGS PANEL HELPERS (restored) ===
function openSettings(){
    try {
        const panel = document.getElementById('settingsPanel') || document.querySelector('.settings-panel');
    if (!panel) { addLog('warning','⚠️ Settings panel not found'); return; }
        panel.classList.add('open');
        document.body.classList.add('settings-open');
    addLog('info','⚙️ Opening settings panel');
        // Lazy bind close if not yet
        const closeBtn = document.getElementById('settingsClose') || panel.querySelector('[data-close-settings]');
        if (closeBtn && !closeBtn.__bound) { closeBtn.addEventListener('click', closeSettings); closeBtn.__bound = true; }
    } catch(err){
        console.error('openSettings error', err);
    }
}

function closeSettings(){
    const panel = document.getElementById('settingsPanel') || document.querySelector('.settings-panel');
    if (!panel) return;
    panel.classList.remove('open');
    document.body.classList.remove('settings-open');
    addLog('info','⚙️ Closing settings panel');
}

// === DISCLAIMER MODAL HANDLERS ===
function openDisclaimerModal(){
    try {
        const modal = document.getElementById('disclaimerModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        document.body.classList.add('modal-open');
        // Bind once
        if (!modal.__bound) {
            const accept = modal.querySelector('#disclaimerAccept');
            const cancel = modal.querySelector('#disclaimerCancel');
            const backdrop = modal.querySelector('[data-close-disclaimer]');
            const checkbox = modal.querySelector('#dismissDisclaimer');
            function dismiss(){
                modal.classList.add('hidden');
                document.body.classList.remove('modal-open');
            }
            if (cancel) cancel.addEventListener('click', dismiss);
            if (backdrop) backdrop.addEventListener('click', dismiss);
            if (accept) accept.addEventListener('click', async ()=>{
                try {
                    if (checkbox?.checked) {
                        localStorage.setItem('ps_disclaimer_ack','1');
                    }
                    dismiss();
                    const btn = elements.botRunButton;
                    if (btn && btn.getAttribute('data-state')==='stopped') {
                        btn.classList.add('starting');
                        await startBot();
                    }
                } catch(e){ addLog('error','Disclaimer accept error: '+e.message); }
                finally {
                    elements.botRunButton?.classList.remove('starting');
                }
            });
            modal.__bound = true;
        }
    } catch(err){ console.error('openDisclaimerModal error', err); }
}

// === RECENT EXECUTIONS RENDERING ===
function renderRecentExecutions(){
    const el = elements.recentExecutions;
    if (!el) return;
    el.innerHTML = '';
    botState.recentExecutions.slice(-30).reverse().forEach(ex => {
        const div = document.createElement('div');
        div.className = `exec-row ${ex.side}`;
        const pnlCls = ex.pnlUsd != null ? (ex.pnlUsd >=0 ? 'pnl-positive':'pnl-negative') : '';
        div.innerHTML = `
            <span class="time">${new Date(ex.time).toLocaleTimeString()}</span>
            <span class="side ${ex.side}">${ex.side.toUpperCase()}</span>
            <span class="sym">${ex.symbol}</span>
            ${ex.sizeSol!=null?`<span class="size">${ex.sizeSol.toFixed(3)} SOL</span>`:''}
            ${ex.pnlUsd!=null?`<span class="pnl ${pnlCls}">${ex.pnlUsd>=0?'+':''}${formatCurrency(ex.pnlUsd)}</span>`:''}
        `;
        el.appendChild(div);
    });

    const clearExecBtn = document.getElementById('clearExecutions');
    if (clearExecBtn) {
        clearExecBtn.addEventListener('click', ()=>{
            botState.recentExecutions = [];
            renderRecentExecutions();
        });
    }
}

function pushExecution(ex){
    botState.recentExecutions.push(ex);
    if (botState.recentExecutions.length > 200) botState.recentExecutions.shift();
    renderRecentExecutions();
}

async function testConnection() {
    const testBtn = document.getElementById('testConnection');
        // Removed testConnection function (button removed)
}

async function stopBot() {
    try {
        updateBotStatus('stopping');
        addLog('info', '🛑 Stopping Solana Sniper Bot...');
        if (window.powersol?.stopBot) {
            const result = await window.powersol.stopBot();
            if (!result.success) throw new Error(result.error || 'Unknown stop error');
        }
        botState.isActive = false;
        // Clear positions when stopping to avoid showing stale data
        botState.openPositions.clear();
        updateBotStatus('stopped');
    schedulePositionsRender(); // Clear position cards (batched)
    addLog('info', '🔴 Bot stopped');
    try { notify.info('Bot stopped', { message:'The bot has been stopped.' }); } catch(_){ }
        stopPnlSnapshotTimer();
    } catch (e) {
        updateBotStatus('error');
    addLog('error', '❌ Stop failed: '+e.message);
    try { notify.error('Stop failed', { message:e.message }); } catch(_){ }
    }
}

function updateBotStatus(status) {
    const statusIcon = elements.statusIndicator?.querySelector('.fas');
    if (!statusIcon || !elements.statusLabel) return;
    const btn = elements.botRunButton;
    switch (status) {
        case 'running':
            statusIcon.className = 'fas fa-circle status-on';
            elements.statusLabel.textContent = 'RUNNING';
            if (btn) { btn.setAttribute('data-state','running'); btn.classList.add('running'); btn.innerHTML = '<i class="fas fa-stop"></i><span class="label">STOP BOT</span>'; btn.classList.remove('starting'); }
            try { addTabBadge('tab-logs', 'LIVE'); } catch(_) {}
            break;
        case 'stopped':
            statusIcon.className = 'fas fa-circle status-off';
            elements.statusLabel.textContent = 'STOPPED';
            if (btn) { btn.setAttribute('data-state','stopped'); btn.classList.remove('running'); btn.innerHTML = '<i class="fas fa-play"></i><span class="label">START BOT</span>'; btn.classList.remove('stopping'); }
            try { removeTabBadge('tab-logs'); } catch(_) {}
            break;
        case 'error':
            statusIcon.className = 'fas fa-circle status-error';
            elements.statusLabel.textContent = 'ERROR';
            if (btn) { btn.setAttribute('data-state','error'); btn.classList.remove('running'); btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i><span class="label">ERROR</span>'; }
            break;
        case 'starting':
        case 'stopping':
            statusIcon.className = 'fas fa-spinner fa-spin status-off';
            elements.statusLabel.textContent = status.toUpperCase() + '...';
            if (btn) {
                btn.setAttribute('data-state', status);
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span class="label">'+status.toUpperCase()+'...</span>';
            }
            break;
    }
}

// === TAB BADGE HELPERS ===
function addTabBadge(tabId, text='!') {
    try {
        const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        if (!btn) return;
        let badge = btn.querySelector('.tab-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tab-badge';
            btn.appendChild(badge);
        }
        badge.textContent = text;
        btn.classList.add('has-badge');
    } catch(err){ console.error('addTabBadge error', err); }
}
function removeTabBadge(tabId) {
    try {
        const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        if (!btn) return;
        btn.classList.remove('has-badge');
        const badge = btn.querySelector('.tab-badge');
        if (badge) badge.remove();
    } catch(err){ console.error('removeTabBadge error', err); }
}

// === STATS UPDATE (QUADRANT 1) ===
function updateStats(stats) {
    // Defensive normalization to avoid TypeErrors if stats undefined/incomplete early in init
    if (!stats || typeof stats !== 'object') {
        stats = { totalPnl: 0, tradesExecuted: 0, salesExecuted: 0, activePositions: 0 };
    }
    const totalPnl = Number(stats.totalPnl) || 0;
    const tradesExecuted = Number(stats.tradesExecuted) || 0;
    const salesExecuted = Number(stats.salesExecuted) || 0;
    const activePositions = Number(stats.activePositions) || 0;
    if (elements.totalPnl) {
        elements.totalPnl.textContent = formatCurrency(totalPnl);
        elements.totalPnl.className = 'stat-value ' + (totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative');
    }
    if (elements.tradesExecuted) elements.tradesExecuted.textContent = tradesExecuted.toString();
    if (elements.salesExecuted) elements.salesExecuted.textContent = salesExecuted.toString();
    if (elements.activePositions) elements.activePositions.textContent = activePositions.toString();
}

function startRuntimeTimer() {
    setInterval(() => {
        if (botState.isActive && botState.startTime) {
            const runtime = Date.now() - botState.startTime;
            elements.runtime.textContent = formatRuntime(runtime);
        }
    }, 1000);
}

// === TOKENS TABLE (QUADRANT 2) ===
function addFoundToken(token) {
    const key = token.address || token.symbol;
    const base = { ...token };
    if (!base.timestamp) base.timestamp = Date.now();
    // Normalize FDV field aliases for market cap display
        if (base.marketCap === undefined && base.fdv !== undefined) base.marketCap = base.fdv; 
        if (base.marketCap === undefined && base.market_cap !== undefined) base.marketCap = base.market_cap;
        if (base.marketCap === undefined && base.fdv !== undefined) base.marketCap = base.fdv;
    // Ensure microstructure canonical fields if present under alt names
    if (base.takerBuyRatioM5 === undefined && base.taker_buy_ratio_m5 !== undefined) base.takerBuyRatioM5 = base.taker_buy_ratio_m5;
    if (base.txM5 === undefined && base.tx_m5 !== undefined) base.txM5 = base.tx_m5;
    if (base.burstFactor === undefined && base.burst_factor !== undefined) base.burstFactor = base.burst_factor;
    botState.foundTokens.set(key, base);
    if (token.priceUsd) updateLastPriceCache(token.symbol || key, token.priceUsd);
    elements.foundTokenCount.textContent = botState.foundTokens.size.toString();
    updateTokensTable();
    updateDiscoveryTable();
    addLog('info', `🆕 Token detected: ${token.symbol}`);
}

function updateTokensTable() {
    if (!elements.tokensTableBody) return;
    const body = elements.tokensTableBody;
    body.innerHTML = '';
    if (!botState.__prevTokenRowPrices) botState.__prevTokenRowPrices = new Map();
    const tokens = sortTokens(Array.from(botState.foundTokens.values())).slice(-15).reverse();
    tokens.forEach(token => {
        const prev = botState.__prevTokenRowPrices.get(token.symbol);
        let flashClass = '';
        if (prev !== undefined && token.priceUsd !== undefined) {
            if (token.priceUsd > prev) flashClass = 'flash-up';
            else if (token.priceUsd < prev) flashClass = 'flash-down';
        }
        const tr = document.createElement('tr');
        const mcap = (token.marketCap !== undefined ? token.marketCap : (token.fdv !== undefined ? token.fdv : null));
        tr.innerHTML = `
            <td><strong>${token.symbol}</strong></td>
            <td class="numeric ${flashClass}">${formatAdaptivePrice(token.priceUsd)}</td>
            <td class="numeric">${formatCurrency(token.liquidity)}</td>
            <td class="numeric">${mcap!=null?formatCurrency(mcap):'-'}</td>`; // Market cap added
        body.appendChild(tr);
        if (token.symbol && token.priceUsd !== undefined) botState.__prevTokenRowPrices.set(token.symbol, token.priceUsd);
    });
}

// Debounced refresh for latest tokens table (avoid excessive DOM churn)
let tokensTableRefreshScheduled = false;
function scheduleTokensTableRefresh(){
    if (tokensTableRefreshScheduled) return;
    tokensTableRefreshScheduled = true;
    requestAnimationFrame(()=>{
        tokensTableRefreshScheduled = false;
        try { updateTokensTable(); } catch(e){ console.warn('tokensTable refresh error', e); }
    });
}

// === POSITIONS TABLE (QUADRANT 3) ===
function addPosition(position) {
    // Normalize backend naming to internal schema
    const sym = position.symbol;
    const ts = Date.now();
    // Helper to compute scaled token amount consistently
    function ensureScaled(rawTokenAmount, tokenAmount, decimals, entryValueUsd, entryPrice){
        if (decimals && decimals > 0 && rawTokenAmount !== undefined) {
            return rawTokenAmount / Math.pow(10, decimals);
        }
        if (tokenAmount !== undefined && tokenAmount !== null && tokenAmount !== 0) return tokenAmount; // already scaled from some sources
        if (entryValueUsd && entryPrice) {
            const derived = entryValueUsd / entryPrice;
            if (isFinite(derived)) return derived;
        }
        return 0;
    }
    const normalized = {
        symbol: position.symbol,
        entryPrice: position.entryPrice ?? position.entry_price ?? position.currentPrice ?? 0,
        currentPrice: position.currentPrice ?? position.entryPrice ?? 0,
        tokenAmount: position.tokenAmount ?? position.token_amount ?? 0,
        amountSol: (position.amountSol ?? position.amount_sol ?? position.amountSol) || 0,
        decimals: position.decimals ?? position.token_decimals ?? 0,
        rawTokenAmount: position.rawTokenAmount ?? position.tokenAmount ?? position.token_amount ?? 0,
        pnlPercent: position.pnlPercent ?? position.pnl_percent ?? 0,
        pnlUsd: position.pnlUsd ?? position.pnl_usd ?? 0,
        entryValueUsd: position.entryValueUsd ?? position.entry_value_usd ?? null,
        timestamp: ts
    };
    // Precompute scaledTokenAmount
    normalized.scaledTokenAmount = ensureScaled(normalized.rawTokenAmount, normalized.tokenAmount, normalized.decimals, normalized.entryValueUsd, normalized.entryPrice);
    botState.openPositions.set(sym, normalized);
    // initialize history
    const startPrice = normalized.entryPrice || normalized.currentPrice || 0;
    botState.priceHistory.set(sym, [{ t: ts, p: startPrice }]);
    schedulePositionsRender();
    updateStats(botState.stats);
    elements.openPositionsCount.textContent = botState.openPositions.size.toString();
}

// Frame-scheduled positions render to collapse multiple triggers into one
let __positionsRenderScheduled = false;
function schedulePositionsRender(){
    if (__positionsRenderScheduled) return;
    __positionsRenderScheduled = true;
    requestAnimationFrame(()=>{
        try { updatePositionsTable(); } catch(_){ }
        try { renderPositionCards(); } catch(_){ }
        __positionsRenderScheduled = false;
    });
}

function updatePositionsTable() {
    const compactBody = elements.positionsTableBody;
    const fullBody = elements.positionsTableBodyFull;
    // Build rows off-DOM to reduce layout thrashing
    let fragC = null, fragF = null;
    if (compactBody) { compactBody.innerHTML = ''; fragC = document.createDocumentFragment(); }
    if (fullBody) { fullBody.innerHTML = ''; fragF = document.createDocumentFragment(); }
    botState.openPositions.forEach(position => {
    // Base % PnL: prefer backend-provided value; otherwise compute safely (avoid division by ~0)
    let basePct;
    if (position.pnlPercent !== undefined) {
        basePct = position.pnlPercent;
    } else {
        const ep = position.entryPrice;
        if (ep && isFinite(ep) && Math.abs(ep) > 1e-12) {
            basePct = (position.currentPrice - ep) / ep * 100;
        } else {
            basePct = 0; // guard against zero / invalid entry price
        }
    }
            const pnlPercent = (position.displayPnlPercent !== undefined) ? position.displayPnlPercent : basePct; 
            if (position.pnlUsd === undefined) position.pnlUsd = position.pnl_usd || 0;
        const decimals = position.decimals || 0;
        const scaledTokenAmount = position.scaledTokenAmount !== undefined
            ? position.scaledTokenAmount
            : (decimals > 0 ? (position.rawTokenAmount||position.tokenAmount||0)/Math.pow(10,decimals) : (position.tokenAmount||0));
        // Entry SOL is what we spent (amountSol) if provided; else derive from entryValueUsd / current SOL price (not available) so keep fallback using scaledTokenAmount*entryPrice
        const entrySol = position.amountSol || (position.entryPrice ? (scaledTokenAmount * position.entryPrice) : 0);
        const currentValueUsd = scaledTokenAmount * position.currentPrice;
        const computedPnlUsd = currentValueUsd - (position.entryPrice * scaledTokenAmount);
        const pnlUsd = (position.displayPnlUsd !== undefined) ? position.displayPnlUsd : (position.pnlUsd !== undefined ? position.pnlUsd : computedPnlUsd);
        // Derive currentValueSol using proportional relationship if entryValueUsd known and amountSol known
        let currentValueSol;
        if (position.amountSol && position.entryPrice > 0 && scaledTokenAmount > 0) {
            const entryUsd = position.entryPrice * scaledTokenAmount;
            currentValueSol = entryUsd > 0 ? position.amountSol * (currentValueUsd / entryUsd) : 0;
        } else {
            currentValueSol = currentValueUsd; // fallback (will look large but guarded below)
        }
        // Sanity guard: if entrySol is absurdly large while amountSol expected small (< 10), trust amountSol
        if (position.amountSol && entrySol > position.amountSol * 10) {
            // Replace derived entrySol with provided amountSol
            // (prevents huge numbers like 57348649729)
            currentValueSol = position.amountSol * (currentValueUsd / Math.max(position.entryPrice * scaledTokenAmount, 1e-9));
        }

        // Detect changes for flash animation
        const prev = botState.previousPositions.get(position.symbol);
        let priceChangeDir = null; // 'up' | 'down'
        let pnlChangeDir = null;
        if (prev) {
            if (position.currentPrice > prev.currentPrice) priceChangeDir = 'up';
            else if (position.currentPrice < prev.currentPrice) priceChangeDir = 'down';
            if (pnlPercent > prev.pnlPercent) pnlChangeDir = 'up';
            else if (pnlPercent < prev.pnlPercent) pnlChangeDir = 'down';
        }
        botState.previousPositions.set(position.symbol, { currentPrice: position.currentPrice, pnlPercent });
        if (compactBody && fragC) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${position.symbol}</strong></td>
                <td><span class="${pnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative'} numeric">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</span></td>
                <td class="${pnlUsd >= 0 ? 'pnl-positive' : 'pnl-negative'} numeric">${formatCurrency(pnlUsd)}</td>
                <td><button class="action-btn sell" data-symbol="${position.symbol}" onclick="confirmSellPosition('${position.symbol}')"><i class="fas fa-arrow-down"></i> SELL</button></td>`;
            fragC.appendChild(tr);
        }
        if (fullBody && fragF) {
            const trf = document.createElement('tr');
            trf.innerHTML = `
                <td><strong>${position.symbol}</strong></td>
                <td class="${pnlChangeDir ? 'flash-'+pnlChangeDir : ''}"><span class="${pnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative'} numeric">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</span></td>
                <td class="${pnlUsd >= 0 ? 'pnl-positive' : 'pnl-negative'} numeric">${formatCurrency(pnlUsd)}</td>
                <td class="numeric">${formatCurrency(position.entryPrice)}</td>
                <td class="numeric ${priceChangeDir ? 'flash-'+priceChangeDir : ''}">${formatAdaptivePrice(position.currentPrice)}</td>
                <td class="numeric">${scaledTokenAmount.toLocaleString(undefined,{maximumFractionDigits:6})}</td>
                <td class="numeric">${formatCurrency(position.entryPrice * scaledTokenAmount)}</td>
                <td class="numeric">${entrySol ? entrySol.toFixed(4) : '-'}</td>
                <td class="numeric">${formatCurrency(currentValueUsd)}</td>
                <td class="numeric">${currentValueSol.toFixed(4)} SOL</td>
                <td><button class="action-btn sell" data-symbol="${position.symbol}" onclick="confirmSellPosition('${position.symbol}')"><i class="fas fa-fire"></i> SELL NOW</button></td>`;
            fragF.appendChild(trf);
        }
    });
    if (compactBody && fragC) compactBody.appendChild(fragC);
    if (fullBody && fragF) fullBody.appendChild(fragF);
}

// === P&L HISTORY & CHART HELPERS (restored after accidental removal) ===
let pnlSnapshotTimer = null;
// Default timeframe aligned with UI default button (24H) instead of previously hardcoded '1H'
let pnlActiveTimeframe = '24H';
let pnlChart = null;
let pnlMiniChart = null;
let pnlChartInitAttempts = 0;

// --- Dynamic loader for ApexCharts (fallback if CDN defer not ready in time) ---
function ensureApexChartsLoaded(){
    return new Promise((resolve,reject)=>{
        if (window.ApexCharts && typeof window.ApexCharts === 'function') return resolve(true);

        // Try local vendor first if not already real ApexCharts
        const hasLocal = !!document.querySelector('script[src*="vendor/apexcharts"]');
        if (hasLocal && window.ApexCharts) {
            // Could be stub or real; if stub string present, continue to CDN fallback
            if (!window.ApexCharts.toString().includes('Stub')) return resolve(true);
        }

        const attemptCdn = ()=>{
            const existing = document.querySelector('script[data-dyn="apexcharts"]');
            if (existing) {
                const maxWait = Date.now()+5000;
                const check = ()=>{
                    if (window.ApexCharts && !window.ApexCharts.toString().includes('Stub')) return resolve(true);
                    if (Date.now()>maxWait) return reject(new Error('ApexCharts CDN load timeout'));
                    setTimeout(check,150);
                };
                return check();
            }
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/apexcharts';
            s.async = true;
            s.setAttribute('data-dyn','apexcharts');
            s.onload = ()=> resolve(true);
            s.onerror = ()=> reject(new Error('Error loading ApexCharts CDN script'));
            document.head.appendChild(s);
        };

        // If local present but stub, go CDN; else if no local at all, try CDN directly.
        attemptCdn();
    });
}
// Static preview seeding (placeholder trend shown before bot starts generating real PnL)
function seedStaticPnlPreview(){
    if (botState.isActive) return;
    if (botState.pnlHistory.length > 0) return;
    const now = Date.now();
    const points = 36; // 18 ore (ogni 30m)
    for (let i = points-1; i>=0; i--) {
        const t = now - i*30*60*1000;
        const base = Math.sin(i/5)*3 + Math.cos(i/11)*2; // curva morbida
        const noise = (Math.random()-0.5)*1.2;
        const v = +(base + noise).toFixed(2);
        botState.pnlHistory.push({ t, v, e: v });
    }
}

function schedulePnlChartRetry(){
    if (pnlChart || pnlChartInitAttempts > 5) return; // give up after several tries
    pnlChartInitAttempts++;
    setTimeout(()=>{
        if (!pnlChart) {
            addLog && addLog('warning', `⏳ Retrying PnL chart init (attempt ${pnlChartInitAttempts})...`);
            initPnlChart();
        }
    }, 1000 * pnlChartInitAttempts);
}

function initPnlChart(){
    const el = document.getElementById('pnl-chart');
    if (!el) {
        console.warn('[PnL] Element #pnl-chart not found at init time');
        schedulePnlChartRetry();
        return;
    }
    if (!window.ApexCharts) {
    console.warn('[PnL] ApexCharts not yet loaded, retrying...');
        schedulePnlChartRetry();
        return;
    }
    try { addLog('info','[PnL] initPnlChart started (history len='+botState.pnlHistory.length+')'); } catch(_){}
    // Visual diagnostic: temporary outline until first successful render
    el.style.outline = '1px dashed rgba(0,255,180,0.4)';
    // Seed initial history point (include equity = realized for start)
    if (botState.pnlHistory.length === 0) botState.pnlHistory.push({ t: Date.now(), v: botState.stats.totalPnl || 0, e: botState.stats.totalPnl || 0 });
    pnlChart = new ApexCharts(el, {
        chart:{ type:'area', height:140, animations:{enabled:false}, toolbar:{show:false}, zoom:{enabled:false}, id:'pnlChartMain' },
        series:[
            { name:'PnL Realizzato', data: transformPnlHistory(botState.pnlHistory, pnlActiveTimeframe, 'v') },
            { name:'Equity (Preview)', data: transformPnlHistory(botState.pnlHistory, pnlActiveTimeframe, 'e') }
        ],
        xaxis:{ type:'datetime', labels:{ show:true } },
        yaxis:{ labels:{ formatter: v => '$'+v.toFixed(2) } },
        stroke:{ curve:'smooth', width:2, dashArray:[0,4] },
        fill:{ type:'gradient', gradient:{ shadeIntensity:0.7, opacityFrom:0.35, opacityTo:0.05, stops:[0,90,100]}},
        colors:['#33C1FF', '#66ff99'], // light green for equity (softer tone)
        grid:{ borderColor:'rgba(255,255,255,0.05)' },
        tooltip:{
            shared:true,
            intersect:false,
            x:{ format:'HH:mm' },
            y:{ formatter: (val, opts)=> '$'+(val!=null?val.toFixed(2):'0.00') }
        }
    });
    try { 
        pnlChart.render().then(()=>{
            try { addLog('success','[PnL] Chart render OK (series='+pnlChart.w.globals.series.length+')'); } catch(_){}
            el.style.outline = 'none';
        });
    } catch(e){ 
        console.warn('PnL chart render failed', e); 
        try { addLog('error','[PnL] Render failed: '+e.message); } catch(_){}
        // fallback placeholder
    el.innerHTML = '<div style="padding:18px;text-align:center;color:#888;font-size:12px;">(Chart not available)</div>';
        pnlChart = null; 
        schedulePnlChartRetry(); 
    }

    // Mini sparkline (still only realized PnL for compact look)
    const miniEl = document.getElementById('pnlMiniChart');
    if (miniEl && window.ApexCharts) {
        try {
            pnlMiniChart = new ApexCharts(miniEl, {
                chart: { type: 'line', height: 42, animations:{enabled:false}, toolbar:{show:false}, zoom:{enabled:false}, sparkline:{ enabled:true } },
                series: [{ data: botState.pnlHistory.map(p=> p.v) }],
                stroke: { width:2, curve:'smooth' },
                colors: ['#33C1FF'],
                tooltip: { enabled:false }
            });
            pnlMiniChart.render();
        } catch(e){ console.warn('Mini PnL chart render failed', e); }
    }
}

function snapshotPnl(){
    const now = Date.now();
    // Realized PnL: viene mantenuto in botState.stats.totalPnl aggiornato dagli eventi stats_update
    const realized = botState.stats.totalPnl || 0; // realized PnL from stats
    // compute unrealized from open positions
    let unrealized = 0;
    try {
        botState.openPositions.forEach(pos => {
            // Prefer backend-provided net PnL if clearly an unrealized figure; otherwise compute
            // We compute using scaled token amount to avoid inflated numbers due to raw base units.
            let scaledAmt;
            if (pos.scaledTokenAmount !== undefined) {
                scaledAmt = pos.scaledTokenAmount;
            } else {
                const raw = (pos.rawTokenAmount !== undefined) ? pos.rawTokenAmount : (pos.tokenAmount !== undefined ? pos.tokenAmount : 0);
                const decimals = pos.decimals || 0;
                scaledAmt = decimals > 0 ? raw / Math.pow(10, decimals) : raw;
            }
            if (!isFinite(scaledAmt)) scaledAmt = 0;
            if (pos.entryPrice !== undefined && pos.currentPrice !== undefined) {
                const diff = (pos.currentPrice - pos.entryPrice);
                let calcUnreal = scaledAmt * diff;
                // If backend gave a net pnlUsd and position is OPEN (no exit), we can cross-check plausibility.
                if (pos.pnlUsdNet !== undefined && isFinite(pos.pnlUsdNet)) {
                    // Accept backend figure only if within 5% of locally computed OR local looks implausible (due to stale price)
                    if (Math.abs(pos.pnlUsdNet - calcUnreal) / (Math.abs(calcUnreal) + 1e-9) < 0.05) {
                        calcUnreal = pos.pnlUsdNet; // trust backend net
                    }
                } else if (pos.pnlUsd !== undefined && isFinite(pos.pnlUsd)) {
                    if (Math.abs(pos.pnlUsd - calcUnreal) / (Math.abs(calcUnreal) + 1e-9) < 0.05) {
                        calcUnreal = pos.pnlUsd;
                    }
                }
                // Guard insanely large values (likely scaling issue prior to this fix)
                if (Math.abs(calcUnreal) > 1e7) {
                    // Emit a one-off diagnostic log (rate limited by symbol memory)
                    if (!pos.__hugePnlWarned) {
                        try { addLog('warning', `[PnL] Valore PnL anomalo per ${pos.symbol}: ${calcUnreal.toFixed(2)} (scaledAmt=${scaledAmt}, diff=${diff})`); } catch(_){}
                        pos.__hugePnlWarned = true;
                    }
                    // Clamp to prevent chart blow-up
                    calcUnreal = Math.sign(calcUnreal) * 1e7;
                }
                unrealized += calcUnreal;
            }
        });
    } catch(e){ /* ignore calc errors */ }
    const equity = realized + unrealized;
    const hist = botState.pnlHistory;
    if (hist.length && (now - hist[hist.length-1].t) < 5000) {
        hist[hist.length-1].v = realized;
        hist[hist.length-1].e = equity;
    } else {
        hist.push({ t: now, v: realized, e: equity });
        if (hist.length > 10000) hist.shift();
    }
}

function transformPnlHistory(hist, timeframe, key='v'){
    const now = Date.now();
    const ranges = {
        '15M': 15*60e3,
        '1H': 60*60e3,
        '4H': 4*60*60e3,
        '12H': 12*60*60e3,
        '1D': 24*60*60e3,
        '24H': 24*60*60e3,
        '7D': 7*24*60*60e3,
        '30D': 30*24*60*60e3
    };
    if (timeframe === 'ALL') return hist.map(p => [p.t, +(p[key]||0).toFixed(2)]);
    const span = ranges[timeframe] || ranges['1D'];
    return hist.filter(p => now - p.t <= span).map(p => [p.t, +(p[key]||0).toFixed(2)]);
}

function refreshPnlChart(){
    if (!pnlChart) { addLog('warning','[PnL] refresh senza chart: provo re-init'); initPnlChart(); if (!pnlChart) return; }
    const realizedData = transformPnlHistory(botState.pnlHistory, pnlActiveTimeframe, 'v');
    const equityData = transformPnlHistory(botState.pnlHistory, pnlActiveTimeframe, 'e');
    try { pnlChart.updateSeries([
        { name:'PnL Realizzato', data: realizedData },
        { name:'Equity (Preview)', data: equityData }
    ]); } catch(e){ 
        console.warn('[PnL] updateSeries failed', e);
        try { addLog('error','[PnL] updateSeries error: '+e.message); } catch(_){}
    }
    if (pnlMiniChart) {
        try { pnlMiniChart.updateSeries([{ data: botState.pnlHistory.slice(-60).map(p=> p.v) }]); } catch(e){ /* ignore */ }
    }
}

function startPnlSnapshotTimer(){
    if (pnlSnapshotTimer) return;
    snapshotPnl();
    refreshPnlChart();
    pnlSnapshotTimer = setInterval(()=>{
        if (!botState.isActive) return;
        snapshotPnl();
        refreshPnlChart();
    }, 60000);
}

function stopPnlSnapshotTimer(){
    if (pnlSnapshotTimer){
        clearInterval(pnlSnapshotTimer);
        pnlSnapshotTimer = null;
    }
}

// === TIMEFRAME SELECTOR ===
function setupPnlTimeframes(){
    const container = document.getElementById('pnlTimeframes');
    if (!container) return; // silently ignore if UI removed
    container.querySelectorAll('button[data-tf]')?.forEach(btn => {
        btn.addEventListener('click', () => {
            const tf = btn.getAttribute('data-tf');
            if (!tf) return;
            pnlActiveTimeframe = tf;
            container.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
            btn.classList.add('active');
            refreshPnlChart();
        });
    });
}

function confirmSellPosition(symbol) {
    if (confirm(`Are you sure you want to sell ${symbol}?`)) {
        sellPosition(symbol);
    }
}

async function sellPosition(symbol) {
    try {
        addLog('warning', `⚙️ SELL REQUEST: ${symbol}`);
        setSellButtonState(symbol, 'pending');
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (window.powersol?.sellPosition) {
            const res = await window.powersol.sellPosition(symbol);
            if (!res?.success) {
                addLog('error', `❌ Sell send failed: ${res?.error || 'unknown error'}`);
            } else {
                const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                addLog('info', `📤 Sell command sent to bot (latency ${(t1-t0).toFixed(0)} ms)`);
            }
        } else {
            addLog('error', '❌ Sell IPC not available');
        }
    } catch (error) {
        addLog('error', `❌ Failed to send sell for ${symbol}: ${error.message}`);
    }
    finally {
        setSellButtonState(symbol, 'idle');
    }
}

// Optimistic UI for SELL buttons across tables and cards
function setSellButtonState(symbol, state){
    try {
        const btns = document.querySelectorAll(`.action-btn.sell[data-symbol="${CSS.escape(symbol)}"], .card-actions .action-btn.sell[data-symbol="${CSS.escape(symbol)}"]`);
        btns.forEach(btn=>{
            if (state === 'pending') {
                if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
                btn.disabled = true;
                btn.classList.add('busy');
                btn.innerHTML = '<i class="fas fa-hourglass-half"></i> SELLING...';
            } else {
                btn.disabled = false;
                btn.classList.remove('busy');
                if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
            }
        });
    } catch(_){ /* no-op */ }
}

// === LOGGING (QUADRANT 4) ===
// Logging dashboard disabled on request: flag to turn it off without removing code.
const LOGGING_ENABLED = true; // Re-enabled to show logs in the Log tab
function setupLogging() {
    if (elements.logLevelFilter) {
        elements.logLevelFilter.addEventListener('change', filterLogs);
    }
    
    if (elements.clearLogs) {
        elements.clearLogs.addEventListener('click', clearLogs);
    }
    if (!LOGGING_ENABLED) {
        // Hide only compact log when disabled, keep full log accessible for debugging
        if (elements.logContainer) {
            elements.logContainer.innerHTML = '';
            elements.logContainer.classList.add('logs-disabled');
        }
    } else {
        // Ensure containers are visible if previously disabled
        [elements.logContainer, elements.logContainerFull].forEach(c => {
            if (c) c.classList.remove('logs-disabled');
        });
    }
}

function addLog(level, message) {
    if (!LOGGING_ENABLED) return; // Silenzia completamente i log UI
    const containers = [elements.logContainer, elements.logContainerFull].filter(Boolean);
    const timestamp = new Date().toLocaleTimeString();
    containers.forEach(container => {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;
        entry.dataset.level = level;
        entry.textContent = `[${timestamp}] ${message}`;
        container.appendChild(entry);
        container.scrollTop = container.scrollHeight;
        while (container.children.length > 800) container.children[0].remove();
    });
}

function filterLogs() {
    const selectedLevel = elements.logLevelFilter.value;
    [elements.logContainer, elements.logContainerFull].forEach(c => {
        if (!c) return;
        c.querySelectorAll('.log-entry').forEach(entry => {
            const lvl = entry.dataset.level;
            entry.style.display = (selectedLevel === 'all' || lvl === selectedLevel) ? 'block' : 'none';
        });
    });
}

function clearLogs() {
    [elements.logContainer, elements.logContainerFull].forEach(c => { if (c) c.innerHTML = ''; });
    if (LOGGING_ENABLED) addLog('info', '🧹 Log cleared');
}

// === TABLE SORTING ===
function setupTableSorting() {
    const headers = document.querySelectorAll('th[data-sort]');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const key = header.dataset.sort;
            if (botState.sortConfig.key === key) {
                botState.sortConfig.direction = botState.sortConfig.direction === 'asc' ? 'desc' : 'asc';
            } else {
                botState.sortConfig.key = key;
                botState.sortConfig.direction = 'asc';
            }
            updateTokensTable();
            updateDiscoveryTable();
        });
    });
}

// Tabs logic
function setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    const tabSelect = document.getElementById('tabSelect');
    if (!tabBtns.length) console.warn('[UI] No .tab-btn elements found for tab setup');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(target).classList.add('active');
            if (tabSelect) tabSelect.value = target;
            // clear badge when opening tab
            if (window.badgeManager) window.badgeManager.clear(target);
        });
    });
    if (tabSelect) {
        tabSelect.addEventListener('change', () => {
            const val = tabSelect.value;
            const btn = document.querySelector(`.tab-btn[data-tab="${val}"]`);
            if (btn) btn.click();
        });
    }
    document.querySelectorAll('[data-nav]').forEach(link => {
        link.addEventListener('click', () => {
            const target = link.getAttribute('data-nav');
            const btn = document.querySelector(`.tab-btn[data-tab="${target}"]`);
            if (btn) btn.click();
        });
    });
    console.log(`[UI] Tabs initialized for ${tabBtns.length} buttons`);
}

// Discovery filtering
function setupDiscoveryFilters() {
    if (elements.tokenSearch) elements.tokenSearch.addEventListener('input', updateDiscoveryTable);
    // Safety filter listener removed
}

function updateDiscoveryTable() {
    if (!elements.discoveryBody) return;
    elements.discoveryBody.innerHTML = '';
    let list = Array.from(botState.foundTokens.values());
    const term = elements.tokenSearch?.value.trim().toLowerCase();
    if (term) list = list.filter(t => t.symbol.toLowerCase().includes(term) || t.name.toLowerCase().includes(term));
    // Safety filtering removed
    list = sortTokens(list);
    list.forEach(token => {
        const tr = document.createElement('tr');
    // Safety & Opportunity rimossi dalla vista discovery normale
    const safetyPct = 0; // mantenuto per compatibilità variabili successive
    const opportunity = 0;
                const dexUrl = `https://dexscreener.com/solana/${token.address || ''}`;
                // Row intensity classes
                let rowClass = 'radar-row-mid';
                if (safetyPct >= 80) rowClass = 'radar-row-high'; else if (safetyPct < 50) rowClass = 'radar-row-low';
                tr.className = `radar-row ${rowClass}`;
                // --- Multi-interval delta calculations (5m / 1h / 6h) ---
                // Priorità: valori DexScreener ricevuti dal backend (delta5, delta60, delta360) -> fallback calcolo locale
                let d5 = (token.delta5 !== undefined ? token.delta5 : null);
                let d60 = (token.delta60 !== undefined ? token.delta60 : null);
                let d360 = (token.delta360 !== undefined ? token.delta360 : null);
                if (d5 === null || d5 === undefined) d5 = computeDeltaMinutes(token.symbol, 5);
                if (d60 === null || d60 === undefined) d60 = computeDeltaMinutes(token.symbol, 60);
                if (d360 === null || d360 === undefined) d360 = computeDeltaMinutes(token.symbol, 360);
                // Flash detection for price cell
                let priceFlashClass = '';
                try {
                    const prevPrice = botState.__prevDiscoveryPrices?.get(token.symbol);
                    if (prevPrice !== undefined && prevPrice !== null && token.priceUsd !== undefined) {
                        if (token.priceUsd > prevPrice) priceFlashClass = 'flash-up';
                        else if (token.priceUsd < prevPrice) priceFlashClass = 'flash-down';
                    }
                } catch(_){ }
                function fmtDelta(v){
                    if (v === null || v === undefined || !isFinite(v)) return '--';
                    const sign = v>0?'+':'';
                    return sign + v.toFixed(2)+'%';
                }
                function clsDelta(v){
                    if (v === null || v === undefined || !isFinite(v)) return 'delta-neutral';
                    if (v >= 2) return 'delta-up';        // strong green
                    if (v <= -2) return 'delta-down';      // strong red
                    // near-flat range highlighted as warn (yellow) to draw eye without bias
                    if (Math.abs(v) < 0.5) return 'delta-warn';
                    return (v > 0 ? 'delta-up' : 'delta-down');
                }
                // Microstructure formatting
                const tbr = (token.takerBuyRatioM5 !== undefined ? token.takerBuyRatioM5 : (token.taker_buy_ratio_m5 !== undefined ? token.taker_buy_ratio_m5 : null));
                const tx5 = (token.txM5 !== undefined ? token.txM5 : (token.tx_m5 !== undefined ? token.tx_m5 : null));
                const burst = (token.burstFactor !== undefined ? token.burstFactor : (token.burst_factor !== undefined ? token.burst_factor : null));
                function fmtTbr(v){ if (v === null || v === undefined || !isFinite(v)) return '--'; return (v*100).toFixed(0)+'%'; }
                function fmtInt(v){ if (v === null || v === undefined || !isFinite(v)) return '--'; return Math.round(v).toString(); }
                function fmtBurst(v){ if (v === null || v === undefined || !isFinite(v)) return '--'; return v.toFixed(2); }
                function clsTbr(v){
                    if (v===null||v===undefined||!isFinite(v)) return 'delta-neutral';
                    if (v >= 0.65) return 'delta-up';      // green
                    if (v <= 0.45) return 'delta-down';    // red
                    return 'delta-warn';                   // yellow zone (meh)
                }
                function clsBurst(v){
                    if (v===null||v===undefined||!isFinite(v)) return 'delta-neutral';
                    if (v >= 1.8) return 'delta-up';       // strong burst
                    if (v < 1.0) return 'delta-down';      // below baseline
                    return 'delta-warn';                   // mild burst ~ neutral
                }
        const ageMs = (token.createdAtMs ? (Date.now() - token.createdAtMs) : (token.timestamp ? (Date.now() - token.timestamp) : null));
        const isNew = ageMs !== null && ageMs < 10*60*1000; // <10 minuti
        function formatAge(ms){
            if (ms === null || ms === undefined) return formatRelativeTime(token.timestamp||Date.now());
            const s = Math.floor(ms/1000);
            if (s < 60) return s+'s';
            const m = Math.floor(s/60);
            if (m < 60) return m+'m';
            const h = Math.floor(m/60);
            if (h < 48) return h+'h';
            const d = Math.floor(h/24);
            return d+'d';
        }
        const mcap = (token.marketCap !== undefined ? token.marketCap : (token.fdv !== undefined ? token.fdv : null));
        tr.innerHTML = `
            <td class="symbol-cell"><span class="sym">${token.symbol}${isNew ? ' <span class=\"badge-new\">NEW</span>' : ''}</span></td>
                        <td class="name-cell"><span class="nm">${token.name}</span></td>
                        <td class="numeric price-cell ${priceFlashClass}">${formatAdaptivePrice(token.priceUsd)}</td>
                        <td class="numeric ${clsDelta(d5)}">${fmtDelta(d5)}</td>
                        <td class="numeric ${clsDelta(d60)}">${fmtDelta(d60)}</td>
                        <td class="numeric ${clsDelta(d360)}">${fmtDelta(d360)}</td>
                        <td class="numeric">${formatCurrency(token.liquidity)}</td>
                        <td class="numeric">${formatCurrency(token.volume24h)}</td>
                        <td class="numeric">${mcap!=null?formatCurrency(mcap):'-'}</td>
                        <td class="actions-cell">
                            <div class="discovery-actions">
                                <button class="btn-icon snipe-button" data-symbol="${token.symbol}" data-address="${token.address}" aria-label="Snipe ${token.symbol}" title="Snipe ${token.symbol}">
                                   <i class="fas fa-crosshairs"></i>
                                </button>
                                <a href="${dexUrl}" class="btn-icon external-link" target="_blank" rel="noopener noreferrer" aria-label="DexScreener ${token.symbol}" title="Apri su DexScreener">
                                   <i class="fas fa-external-link-alt"></i>
                                </a>
                            </div>
                        </td>
                        <td class="numeric">${formatAge(ageMs)}</td>
                        <td class="numeric ${clsTbr(tbr)}">${fmtTbr(tbr)}</td>
                        <td class="numeric">${fmtInt(tx5)}</td>
                        <td class="numeric ${clsBurst(burst)}">${fmtBurst(burst)}</td>`;
        elements.discoveryBody.appendChild(tr);
        // Store latest price
        if (!botState.__prevDiscoveryPrices) botState.__prevDiscoveryPrices = new Map();
        if (token.symbol && token.priceUsd !== undefined) botState.__prevDiscoveryPrices.set(token.symbol, token.priceUsd);
    });
    // Removed manual snipe button (test control) per richiesta
}

// === FAST PRICE PROPAGATION (debounced discovery refresh) ===
let discoveryRefreshScheduled = false;
function scheduleDiscoveryRefresh() {
    if (discoveryRefreshScheduled) return;
    discoveryRefreshScheduled = true;
    requestAnimationFrame(() => {
        discoveryRefreshScheduled = false;
        try { updateDiscoveryTable(); } catch(e){ console.warn('Discovery refresh error', e); }
    });
}

// === PriceUpdateManager (aggregated backend batch events) ===
const PriceUpdateManager = (function(){
    const lastApplied = new Map(); // symbol -> last price
    const lastUiUpdateTs = new Map(); // symbol -> last UI refresh ts
    let pending = new Map();
    let rafScheduled = false;
    const MIN_BPS = 0.2; // 0.002% filtro micro-rumore (ancora meno conservativo)
    const MAX_STALE_MS = 1200; // forza un refresh anche con delta < MIN_BPS dopo ~1.2s
    function scheduleFlush(){
        if (rafScheduled) return;
        rafScheduled = true;
        requestAnimationFrame(()=>{
            rafScheduled = false;
            if (!pending.size) return;
            let anyDiscovery = false;
            const now = Date.now();
            for (const [sym, data] of pending.entries()) {
                const prev = lastApplied.get(sym);
                const price = data.price;
                if (price == null || !isFinite(price) || price <= 0) continue;
                let apply = true;
                if (prev && prev > 0) {
                    const bps = Math.abs(price - prev)/prev*10000;
                    if (bps < MIN_BPS) {
                        // check staleness: if we haven't updated this symbol for a while, allow a refresh anyway
                        const lastTs = lastUiUpdateTs.get(sym) || 0;
                        if ((now - lastTs) < MAX_STALE_MS) apply = false;
                    }
                }
                if (!apply) continue;
                lastApplied.set(sym, price);
                // Update positions if open
                if (botState.openPositions.has(sym)) {
                    const pos = botState.openPositions.get(sym);
                    pos.currentPrice = price;
                    // Defer pnl recompute: already arrives from backend loop, but fallback here
                    if (pos.entryPrice) {
                        pos.pnlPercent = (price/pos.entryPrice - 1)*100;
                        const scaled = pos.scaledTokenAmount || pos.tokenAmount || 0;
                        pos.pnlUsd = (price - pos.entryPrice) * scaled;
                        // mark UI update ts for staleness logic
                        lastUiUpdateTs.set(sym, now);
                    }
                }
                // Update discovery token
                updateFoundTokenPriceFromPosition(sym, price);
                // Mark UI update even for discovery-only tokens
                lastUiUpdateTs.set(sym, now);
                anyDiscovery = true;
            }
            pending.clear();
            if (anyDiscovery) scheduleDiscoveryRefresh();
            // Batch refresh of position UI (table + cards)
            schedulePositionsRender();
        });
    }
    function ingestBatch(updates){
        if (!Array.isArray(updates)) return;
        updates.forEach(u=>{
            if (!u || !u.symbol) return;
            pending.set(u.symbol, { price: u.currentPrice, ts: u.ts });
        });
        scheduleFlush();
    }
    return { ingestBatch };
})();

function updateFoundTokenPriceFromPosition(symbol, price){
    if (!symbol || price === undefined || price === null) return;
    // Direct key hit (some tokens keyed by symbol if address missing)
    if (botState.foundTokens.has(symbol)) {
        const tk = botState.foundTokens.get(symbol);
        if (tk && tk.priceUsd !== price) {
            tk.priceUsd = price;
            botState.foundTokens.set(symbol, tk);
        }
        return;
    }
    // Fallback scan (tokens usually keyed by address)
    for (const [k, tk] of botState.foundTokens.entries()) {
        if (tk && tk.symbol === symbol) {
            if (tk.priceUsd !== price) {
                tk.priceUsd = price;
                botState.foundTokens.set(k, tk);
            }
            break;
        }
    }
}

function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h + 'h';
}

// Settings (expanded)
function setupSettings() {
    if (!elements.saveSettings) return;
    const statusEl = document.getElementById('settingsStatus');

    const keyList = [
        'PRIVATE_KEY','MORALIS_API_KEY','HELIUS_API_KEY','BIRDEYE_API_KEY',
    'TRADE_AMOUNT_SOL','MAX_POSITIONS','MIN_SAFETY_SCORE','MIN_VOLUME_24H','MIN_HOLDERS','MIN_LIQUIDITY',
    'TOKEN_AGE_HOURS_MIN','TOKEN_AGE_HOURS_MAX','SCAN_INTERVAL_SECONDS','MAX_TOKENS_PER_SCAN','MONITOR_INTERVAL','PRICE_CACHE_SECONDS',
    'ENABLE_SMART_CACHING','STOP_LOSS_PERCENT','TAKE_PROFIT_PERCENT',
        'TRAILING_STOP_TRIGGER','TRAILING_STOP_PERCENT','FAST_SELL_ENABLED','PANIC_SELL_THRESHOLD','BUY_SLIPPAGE_BPS','SELL_SLIPPAGE_BPS',
        'ENABLE_AUTO_TRADING','ENABLE_REAL_TRADES','ENABLE_SELLS','REQUIRE_VERIFIED_DATA','ENABLE_HONEYPOT_CHECK','ALLOW_UNSAFE_MANUAL_SNIPE'
    ];

    function buildSettingsObject() {
        const collect = id => elements[id]?.value?.trim();
        const settings = {};
        keyList.forEach(k => { if (elements[k]) settings[k] = collect(k) || ''; });
        // Enforce min 0.1 on TRADE_AMOUNT_SOL silently if present
        if (settings.TRADE_AMOUNT_SOL) {
            const ta = parseFloat(settings.TRADE_AMOUNT_SOL);
            if (!isNaN(ta) && ta < 0.1) {
                settings.TRADE_AMOUNT_SOL = '0.10';
                if (elements.TRADE_AMOUNT_SOL) elements.TRADE_AMOUNT_SOL.value = '0.10';
            }
        }
        // Legacy
        if (elements.rpcEndpoint?.value && !settings.SOLANA_RPC_PRIMARY) settings.SOLANA_RPC_PRIMARY = elements.rpcEndpoint.value.trim();
        if (elements.slippage?.value && !settings.BUY_SLIPPAGE_BPS) {
            const pct = parseFloat(elements.slippage.value); if (!isNaN(pct)) settings.BUY_SLIPPAGE_BPS = String(Math.round(pct * 100));
        }
        if (elements.stopLoss?.value && !settings.STOP_LOSS_PERCENT) settings.STOP_LOSS_PERCENT = elements.stopLoss.value.trim();
        // Enforce default fee percentage if blank
    // Fee percentage removed from UI/env; internal default remains in backend if needed.
        return settings;
    }

    function validateSettings(settings) {
        const errors = [];
        const numeric = (field, opts={}) => {
            if (!(field in settings) || settings[field]==='') return; // optional
            const isInt = !!opts.int;
            const v = isInt ? parseInt(settings[field],10) : parseFloat(settings[field]);
            if (isNaN(v)) { errors.push(`Valore non numerico per ${field}`); return; }
            if (opts.min!==undefined && v < opts.min) errors.push(`${field} < ${opts.min}`);
            if (opts.max!==undefined && v > opts.max) errors.push(`${field} > ${opts.max}`);
        };
        // Silent clamp already applied in buildSettingsObject, no error push for trade amount
        numeric('BUY_SLIPPAGE_BPS',{min:0,max:5000,int:true});
        numeric('SELL_SLIPPAGE_BPS',{min:0,max:5000,int:true});
        numeric('STOP_LOSS_PERCENT',{min:0,max:100});
        numeric('TAKE_PROFIT_PERCENT',{min:0,max:10000});
        numeric('TRAILING_STOP_PERCENT',{min:0,max:100});
        numeric('TRAILING_STOP_TRIGGER',{min:0,max:10000});
        numeric('PANIC_SELL_THRESHOLD',{min:0,max:1000});
        return errors;
    }

    function normalizeBooleans(settings) {
        ['ENABLE_SMART_CACHING','FAST_SELL_ENABLED','ENABLE_AUTO_TRADING','ENABLE_REAL_TRADES','ENABLE_SELLS','REQUIRE_VERIFIED_DATA','ENABLE_HONEYPOT_CHECK','ALLOW_UNSAFE_MANUAL_SNIPE']
            .forEach(b=>{ if (settings[b]) settings[b] = settings[b].toLowerCase()==='true'?'true':'false'; });
    }

    let saveTimer = null;
    let pending = false;
    async function autoSave(trigger='change') {
        if (pending) return; // prevent overlapping
        const settings = buildSettingsObject();
        const errors = validateSettings(settings);
        if (errors.length) {
            statusEl && (statusEl.textContent = 'Error');
            errors.forEach(e=>addLog('error','❌ '+e));
            return;
        }
        normalizeBooleans(settings);
        if (!window.powersol?.saveSettings) return; // demo mode
        try {
            pending = true;
            statusEl && (statusEl.textContent = 'Saving...');
            const res = await window.powersol.saveSettings(settings);
            if (res?.success) {
                statusEl && (statusEl.textContent = 'Saved ✓');
                if (trigger === 'manual') addLog('success','✅ Settings saved');
                // Live push ENABLE_AUTO_TRADING to backend if running
                try {
                    if (window.powersol?.getBotStatus && window.powersol?.sendCommand) {
                        const st = await window.powersol.getBotStatus();
                        if (st?.running && settings.ENABLE_AUTO_TRADING) {
                            const val = settings.ENABLE_AUTO_TRADING === 'true';
                            await window.powersol.sendCommand({ cmd:'config', action:'set', key:'ENABLE_AUTO_TRADING', value: val });
                            addLog('info', `⚙️ Auto-trading set to ${val}`);
                            // Update UI chip immediately
                            try { updateAutoTradingChip(val); } catch(_){ }
                        }
                            // (Microstructure settings removed from UI; backend thresholds can still be updated via console if needed)
                    }
                } catch(_){ /* optional */ }
            } else {
                statusEl && (statusEl.textContent = 'Error');
                addLog('error','❌ Save failed: '+(res?.error||'unknown'));
            }
        } catch (err) {
            statusEl && (statusEl.textContent = 'Error');
            addLog('error','❌ Save error: '+err.message);
        } finally {
            pending = false;
            if (statusEl) setTimeout(()=>{ if (statusEl.textContent.startsWith('Saved')) statusEl.textContent=''; }, 2500);
        }
    }

    function scheduleAutoSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(()=>autoSave('auto'), 600); // 600ms debounce
        if (document.getElementById('settingsStatus') && !pending) {
            document.getElementById('settingsStatus').textContent = 'Modified…';
        }
    }

    // Attach listeners
    keyList.forEach(k=>{
        if (!elements[k]) return;
        // Private key: save only on blur to avoid frequent writes while typing
        if (k === 'PRIVATE_KEY') {
            elements[k].addEventListener('blur', scheduleAutoSave);
        } else {
            ['input','change'].forEach(ev=> elements[k].addEventListener(ev, scheduleAutoSave));
        }
    });

    // Manual button triggers immediate save
    elements.saveSettings.addEventListener('click', (e)=>{
        e.preventDefault();
        autoSave('manual');
    });

    // Sidebar navigation (new layout)
    const nav = document.getElementById('settingsGroupsNav');
    const groups = Array.from(document.querySelectorAll('.settings-group'));
    if (nav && groups.length) {
        nav.addEventListener('click', (e)=>{
            const btn = e.target.closest('button[data-target]');
            if (!btn) return;
            const target = btn.getAttribute('data-target');
            nav.querySelectorAll('button').forEach(b=>b.classList.toggle('active', b===btn));
            if (target === 'all') {
                groups.forEach(g=>g.removeAttribute('data-hidden'));
                // Scroll to top of settings content
                const sc = document.getElementById('settingsContent');
                if (sc) sc.scrollTop = 0;
                return;
            }
            groups.forEach(g=>{
                if (g.getAttribute('data-group') === target) g.removeAttribute('data-hidden');
                else g.setAttribute('data-hidden','true');
            });
            const el = document.querySelector(`.settings-group[data-group="${target}"]`);
            if (el) el.scrollIntoView({behavior:'smooth', block:'start'});
        });
    }

    // Live search filter
    const searchInput = document.getElementById('settingsSearch');
    if (searchInput) {
        searchInput.addEventListener('input', ()=>{
            const q = searchInput.value.trim().toLowerCase();
            if (!q) {
                groups.forEach(g=>g.removeAttribute('data-hidden'));
                return;
            }
            groups.forEach(g=>{
                const text = g.textContent.toLowerCase();
                if (text.includes(q)) g.removeAttribute('data-hidden'); else g.setAttribute('data-hidden','true');
            });
        });
    }
}

// Sorting helper (extracted after corruption fix)
function sortTokens(tokens) {
    if (!botState.sortConfig.key) return tokens;
    return tokens.sort((a, b) => {
        const key = botState.sortConfig.key;
        const aVal = a[key];
        const bVal = b[key];
        let comparison = 0;
        if (Number.isFinite(aVal) && Number.isFinite(bVal)) comparison = aVal - bVal;
        else comparison = String(aVal ?? '').localeCompare(String(bVal ?? ''));
        return botState.sortConfig.direction === 'desc' ? -comparison : comparison;
    });
}

// === UTILITY FUNCTIONS ===
function formatCurrency(value) {
    if (typeof value !== 'number' || isNaN(value)) return '$0.00';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}

function formatSol(value, max=4){
    if (typeof value !== 'number' || isNaN(value)) return '0.0000';
    return value.toFixed(max);
}

function formatRuntime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function getSafetyClass(score) {
    if (score >= 80) return 'safety-high';
    if (score >= 50) return 'safety-medium';
    return 'safety-low';
}

function formatAdaptivePrice(val){
    if (val === undefined || val === null) return '-';
    if (val === 0) return '$0.00000000';
    if (val < 0.0001) return '$' + val.toFixed(8);
    if (val < 0.01) return '$' + val.toFixed(6);
    return formatCurrency(val);
}

// === SHORT TERM PRICE DELTA HELPERS (Radar 2.0) ===
function updateLastPriceCache(symbol, price) {
    if (!symbol) return;
    const now = Date.now();
    let arr = lastPriceCache.get(symbol);
    if (!arr) { arr = []; lastPriceCache.set(symbol, arr); }
    arr.push({ t: now, p: price });
    const cutoff = now - PRICE_HISTORY_RETENTION_MS; // prune beyond retention window
    while (arr.length && arr[0].t < cutoff) arr.shift();
}

function computeRecentDelta(symbol) {
    const series = lastPriceCache.get(symbol);
    if (!series || series.length < 2) return { pct: null, refSeconds: 0 };
    const now = Date.now();
    // Use a short recent window (e.g. 30s) for the radar quick delta; derive from last 30s if possible
    const windowStart = now - 30 * 1000;
    let base = series[0];
    for (let i = 0; i < series.length; i++) {
        if (series[i].t >= windowStart) { base = series[i]; break; }
    }
    const latest = series[series.length - 1];
    if (!latest || !base || !base.p) return { pct: null, refSeconds: 0 };
    const pct = ((latest.p - base.p) / base.p) * 100;
    return { pct, refSeconds: Math.max(1, Math.round((latest.t - base.t)/1000)) };
}

// Multi-interval delta (minutes) used in Discovery columns (5m/60m/360m)
function computeDeltaMinutes(symbol, minutes){
    const series = lastPriceCache.get(symbol);
    if (!series || !series.length) return null;
    const now = Date.now();
    const lookback = now - minutes*60*1000;
    // Find first point >= lookback or earliest
    let ref = series[0];
    for (let i = 0; i < series.length; i++) {
        if (series[i].t >= lookback) { ref = series[i]; break; }
    }
    const latest = series[series.length - 1];
    if (!ref || !latest || !ref.p || !latest.p) return null;
    if (ref === latest) return 0;
    return ((latest.p - ref.p)/ref.p)*100;
}

// === EVENT LISTENERS ===
function setupEventListeners() {
    // Helper: build a stable key for a closed trade
    function makeCloseKey(src) {
        if (!src) return null;
        if (src.id) return String(src.id);
        const sym = src.symbol || 'UNKNOWN';
        // allow both seconds and ms in input
        const closedAtSec = (typeof src.closedAt === 'number') ? (src.closedAt > 1e12 ? Math.round(src.closedAt/1000) : Math.round(src.closedAt)) : Math.round(Date.now()/1000);
        const closedAtMs = Math.round(closedAtSec * 1000);
        return `${sym}_${closedAtMs}`;
    }

    // Helper: push or unshift closed trade if not already present
    function addClosedTrade(entry, { toFront=false } = {}) {
        const key = makeCloseKey(entry);
        if (!key) return false;
        if (botState.closedTradeKeys.has(key)) {
            addLog && addLog('debug', `Skipped duplicate history entry ${key}`);
            return false;
        }
        botState.closedTradeKeys.add(key);
        if (toFront) botState.closedTrades.unshift(entry);
        else botState.closedTrades.push(entry);
        // Bound list sizes
        if (botState.closedTrades.length > 1000) {
            // remove from the opposite end; key pruning is best-effort
            const removed = botState.closedTrades.pop();
            try {
                const rkey = makeCloseKey(removed);
                if (rkey) botState.closedTradeKeys.delete(rkey);
            } catch(_){}
        }
        return true;
    }
    //
    if (window.powersol?.onBotData) {
        window.powersol.onBotData(data => {
            if (data.type === 'sell_result') {
                const r = data.result || data;
                if (r.ok) addLog('success', `✅ Sell accepted for ${r.symbol} (${r.status||''})`);
                else addLog('error', `❌ Sell failed: ${r.error || 'unknown'}`);
                try { toastManager.sellProgress(r); } catch(_){ }
                try { window.badgeManager?.bumpForEvent('sell_result'); } catch(_){ }
                return;
            }
            if (data.type === 'position_closed') {
                const p = data.position || data.data || data;
                const sym = p.symbol;
                if (sym) {
                    // Capture openedAt from existing position (before delete)
                    const openedAtTs = botState.openPositions.get(sym)?.timestamp || null;
                    // Normalize percent selection: ALWAYS prefer realized percent; avoid gross recompute that ignores fees
                    let pnlPercent = undefined;
                    if (p.realizedPnlPercent !== undefined && isFinite(p.realizedPnlPercent)) {
                        pnlPercent = p.realizedPnlPercent;
                    } else if (p.pnlPercentNet !== undefined && isFinite(p.pnlPercentNet)) {
                        pnlPercent = p.pnlPercentNet;
                    } else if (p.pnlPercent !== undefined && isFinite(p.pnlPercent)) {
                        pnlPercent = p.pnlPercent;
                    } else if (p.pnl_percent !== undefined && isFinite(p.pnl_percent)) {
                        pnlPercent = p.pnl_percent;
                    } else if (p.realizedPnlUsd !== undefined && p.costBasisSol !== undefined && p.proceedsSol !== undefined && isFinite(p.costBasisSol) && p.costBasisSol > 0) {
                        // Derive percent using SOL delta with fees-inclusive basis if backend omitted realized percent
                        const realizedDeltaSol = p.proceedsSol - p.costBasisSol;
                        pnlPercent = (realizedDeltaSol / p.costBasisSol) * 100;
                    }
                    const entryPrice = p.entryPrice ?? p.entry_price ?? 0;
                    const exitPrice = p.exitPrice ?? p.exit_price ?? p.currentPrice ?? 0;
                    const amount = p.amountSol ?? p.amount ?? 0;
                    const tokenAmount = p.tokenAmount ?? p.token_amount ?? 0;
                    const pnlUsd = (p.realizedPnlUsd !== undefined ? p.realizedPnlUsd : (p.pnl ?? p.pnlUsd ?? p.pnl_usd ?? 0));
                    // Divergence safeguard logging
                    if (p.realizedPnlUsd !== undefined && pnlPercent !== undefined && isFinite(p.realizedPnlUsd) && isFinite(pnlPercent)) {
                        const signMismatch = Math.sign(p.realizedPnlUsd) !== Math.sign(pnlPercent) && Math.abs(p.realizedPnlUsd) > 0.01 && Math.abs(pnlPercent) > 0.2;
                        if (signMismatch) {
                            addLog('warn', `⚠️ PnL divergence detected for ${sym}: realizedUsd=${p.realizedPnlUsd.toFixed(4)} vs percent=${pnlPercent.toFixed(2)}% (costBasisSol=${p.costBasisSol}, proceedsSol=${p.proceedsSol})`);
                        }
                    }
                    // Do NOT insert into closedTrades here to avoid duplication.
                    // We'll rely on trade_history_entry (with stable id) to populate history.
                    // Now remove open position and update UI
                    if (botState.openPositions.has(sym)) botState.openPositions.delete(sym);
                    addLog('info', `💼 Position closed: ${sym}`);
                    // Misfire tag
                    if (p.reason && /MISFIRE_TP/i.test(p.reason)) {
                        addLog('warning', `⚠️ TP misfire detected for ${p.symbol}: ${p.reason}`);
                    }
                    try { toastManager.positionClosed(p); } catch(_){ }
                    schedulePositionsRender();
                    elements.openPositionsCount.textContent = botState.openPositions.size.toString();
                    // rendering of history will occur on trade_history_entry
                }
                try { window.badgeManager?.bumpForEvent('position_closed'); } catch(_){ }
                return;
            }
            if (data.type === 'token_found') {
                const t = data.token || data || {};
                // Normalize naming between backend JSON and frontend expectations
                const normalized = {
                    symbol: t.symbol || t.name || 'UNKNOWN',
                    name: t.name || t.symbol || 'Unknown Token',
                    address: t.address,
                    priceUsd: (t.priceUsd !== undefined ? t.priceUsd : (t.price_usd !== undefined ? t.price_usd : (t.price !== undefined ? t.price : 0))),
                    liquidity: t.liquidity || 0,
                    volume24h: t.volume24h || t.volume_24h || 0,
                    safetyScore: t.safetyScore || t.safety_score || 0,
                    source: t.source || 'Bot'
                };
                if (t.fdv !== undefined) normalized.marketCap = t.fdv;
                if (t.market_cap !== undefined) normalized.marketCap = t.market_cap;
                // Parse creation time if provided
                if (t.created_at) {
                    const ms = Date.parse(t.created_at);
                    if (!isNaN(ms)) normalized.createdAtMs = ms;
                }
                // Conserva eventuali delta pre-calcolati dal backend (DexScreener)
                if (t.delta5 !== undefined) normalized.delta5 = t.delta5;
                if (t.delta60 !== undefined) normalized.delta60 = t.delta60;
                if (t.delta360 !== undefined) normalized.delta360 = t.delta360;
                // Microstructure
                if (t.taker_buy_ratio_m5 !== undefined) normalized.takerBuyRatioM5 = t.taker_buy_ratio_m5;
                if (t.tx_m5 !== undefined) normalized.txM5 = t.tx_m5;
                if (t.burst_factor !== undefined) normalized.burstFactor = t.burst_factor;
                if (normalized.priceUsd) updateLastPriceCache(normalized.symbol, normalized.priceUsd);
                addFoundToken(normalized);
                try { window.badgeManager?.bumpForEvent('token_found'); } catch(_){ }
            } else if (data.type === 'token_update') {
                const t = data.token || data;
                const key = t.address || t.symbol;
                if (key && botState.foundTokens.has(key)) {
                    const existing = botState.foundTokens.get(key);
                    if (t.safetyScore !== undefined || t.safety_score !== undefined) {
                        existing.safetyScore = t.safetyScore || t.safety_score;
                    }
                    if (t.opportunityScore !== undefined || t.opportunity_score !== undefined) {
                        existing.opportunityScore = t.opportunityScore || t.opportunity_score;
                    }
                    if (t.price_usd !== undefined) {
                        existing.priceUsd = t.price_usd;
                        updateLastPriceCache(existing.symbol || key, existing.priceUsd);
                    }
                    if (t.liquidity !== undefined) existing.liquidity = t.liquidity;
                    if (t.volume_24h !== undefined) existing.volume24h = t.volume_24h;
                    if (t.fdv !== undefined) existing.marketCap = t.fdv;
                    if (t.market_cap !== undefined) existing.marketCap = t.market_cap;
                    // Aggiorna delta se presenti (job periodico backend)
                    if (t.delta5 !== undefined) existing.delta5 = t.delta5;
                    if (t.delta60 !== undefined) existing.delta60 = t.delta60;
                    if (t.delta360 !== undefined) existing.delta360 = t.delta360;
                    // Microstructure updates
                    if (t.taker_buy_ratio_m5 !== undefined) existing.takerBuyRatioM5 = t.taker_buy_ratio_m5;
                    if (t.tx_m5 !== undefined) existing.txM5 = t.tx_m5;
                    if (t.burst_factor !== undefined) existing.burstFactor = t.burst_factor;
                    // Capture creation time if provided later
                    if (t.created_at && !existing.createdAtMs) {
                        const ms = Date.parse(t.created_at);
                        if (!isNaN(ms)) existing.createdAtMs = ms;
                    }
                    botState.foundTokens.set(key, existing);
                    updateTokensTable();
                    scheduleDiscoveryRefresh(); // faster visual update
                    renderRadarTokens();
                }
            } else if (data.type === 'radar_snapshot') {
                const list = data.tokens || [];
                let updated = false;
                list.forEach(t => {
                    const key = t.address || t.symbol;
                    if (!key) return;
                    const existing = botState.foundTokens.get(key) || {
                        symbol: t.symbol || t.name || 'UNKNOWN',
                        name: t.name || t.symbol || 'Unknown Token',
                        address: t.address,
                        priceUsd: 0,
                        liquidity: 0,
                        volume24h: 0,
                        safetyScore: 0,
                        opportunityScore: 0,
                        source: t.source || 'Bot',
                        timestamp: Date.now()
                    };
                    if (t.price_usd !== undefined) { existing.priceUsd = t.price_usd; updateLastPriceCache(existing.symbol, existing.priceUsd); }
                    if (t.liquidity !== undefined) existing.liquidity = t.liquidity;
                    if (t.volume_24h !== undefined) existing.volume24h = t.volume_24h;
                    if (t.fdv !== undefined) existing.marketCap = t.fdv;
                    if (t.market_cap !== undefined) existing.marketCap = t.market_cap;
                    if (t.safety_score !== undefined) existing.safetyScore = t.safety_score;
                    if (t.opportunity_score !== undefined) existing.opportunityScore = t.opportunity_score;
                    // Microstructure
                    if (t.taker_buy_ratio_m5 !== undefined) existing.takerBuyRatioM5 = t.taker_buy_ratio_m5;
                    if (t.tx_m5 !== undefined) existing.txM5 = t.tx_m5;
                    if (t.burst_factor !== undefined) existing.burstFactor = t.burst_factor;
                    if (t.created_at && !existing.createdAtMs) {
                        const ms = Date.parse(t.created_at);
                        if (!isNaN(ms)) existing.createdAtMs = ms;
                    }
                    botState.foundTokens.set(key, existing);
                    updated = true;
                });
                if (updated) {
                    elements.foundTokenCount.textContent = botState.foundTokens.size.toString();
                    updateTokensTable();
                    scheduleDiscoveryRefresh();
                    renderRadarTokens();
                }
            } else if (data.type === 'position_opened') {
                addPosition(data.position);
                botState.positionEvents++;
                if (data.position?.symbol) {
                    pushExecution({
                        time: Date.now(),
                        side: 'buy',
                        symbol: data.position.symbol,
                        sizeSol: data.position.amount || data.position.tokenAmount || null
                    });
                    try { toastManager.positionOpened(data.position); } catch(_){ }
                    try { window.badgeManager?.bumpForEvent('position_opened'); } catch(_){ }
                }
            } else if (data.type === 'position_update') {
                const p = data.position || data;
                if (p.symbol && botState.openPositions.has(p.symbol)) {
                    const existing = botState.openPositions.get(p.symbol);
                    if (p.currentPrice !== undefined) existing.currentPrice = p.currentPrice;
                    if (p.pnlPercent !== undefined) existing.pnlPercent = p.pnlPercent;
                    if (p.pnlUsd !== undefined) existing.pnlUsd = p.pnlUsd;
                    // Net vs Gross fields (new)
                    if (p.pnlPercentNet !== undefined) existing.pnlPercentNet = p.pnlPercentNet;
                    if (p.pnlUsdNet !== undefined) existing.pnlUsdNet = p.pnlUsdNet;
                    if (p.pnlPercentGross !== undefined) existing.pnlPercentGross = p.pnlPercentGross;
                    if (p.entryCostBasisSol !== undefined) existing.entryCostBasisSol = p.entryCostBasisSol;
                    if (p.entryCostBasisUsd !== undefined) existing.entryCostBasisUsd = p.entryCostBasisUsd;
                    if (p.feesPaidBuySol !== undefined) existing.feesPaidBuySol = p.feesPaidBuySol;
                    if (p.tokenAmount !== undefined) existing.tokenAmount = p.tokenAmount;
                    if (p.rawTokenAmount !== undefined) existing.rawTokenAmount = p.rawTokenAmount;
                    if (p.decimals !== undefined) existing.decimals = p.decimals;
                    // Recompute scaled token amount if any underlying changed
                    try {
                        const decimals = existing.decimals || 0;
                        if (decimals > 0 && existing.rawTokenAmount !== undefined) {
                            existing.scaledTokenAmount = existing.rawTokenAmount / Math.pow(10, decimals);
                        } else if (existing.tokenAmount !== undefined) {
                            existing.scaledTokenAmount = existing.tokenAmount;
                        }
                    } catch(_){ }
                    // Preferred display metrics (net first)
                    existing.displayPnlPercent = (p.pnlPercentNet !== undefined) ? p.pnlPercentNet : (p.pnlPercent !== undefined ? p.pnlPercent : existing.displayPnlPercent);
                    existing.displayPnlUsd = (p.pnlUsdNet !== undefined) ? p.pnlUsdNet : (p.pnlUsd !== undefined ? p.pnlUsd : existing.displayPnlUsd);
                    if (p.currentPrice !== undefined) {
                const hist = botState.priceHistory.get(p.symbol) || [];
                // Normalize to a stable precision to avoid minor UI mismatches
                const normPrice = Number(p.currentPrice);
                const rounded = (Number.isFinite(normPrice) ? +normPrice.toFixed(12) : normPrice);
                hist.push({ t: Date.now(), p: rounded });
                        if (hist.length > 150) hist.shift();
                botState.priceHistory.set(p.symbol, hist);
                updateLastPriceCache(p.symbol, rounded);
                        // Propagate immediately to discovery token row if present
                updateFoundTokenPriceFromPosition(p.symbol, rounded);
                        scheduleDiscoveryRefresh();
                        scheduleTokensTableRefresh();
                    }
                    schedulePositionsRender();
                    try { toastManager.positionUpdate(p); } catch(_){ }
                }
            } else if (data.type === 'batched_price_update') {
                try {
                    if (data.updates) {
                        PriceUpdateManager.ingestBatch(data.updates);
                        scheduleTokensTableRefresh();
                    }
                } catch(e){ console.warn('Batch price update error', e); }
            } else if (data.type === 'stats_update') {
                botState.stats = { ...botState.stats, ...data.stats };
                updateStats(botState.stats);
                snapshotPnl();
                refreshPnlChart();
            } else if (data.type === 'snipe_result') {
                const r = data.result || data;
                if (r.ok) addLog('success', `🎯 Snipe status: ${r.symbol || ''} ${r.status||''}`);
                else addLog('error', `❌ Snipe failed: ${r.error || 'unknown error'}`);
                try { toastManager.snipeProgress(r); } catch(_){ }
                try { window.badgeManager?.bumpForEvent('snipe_result'); } catch(_){ }
            } else if (data.type === 'trade_history_snapshot') {
                const snap = data.snapshot || data;
                const entries = snap.entries || [];
                // Reset snapshot state to avoid duplication
                botState.closedTrades = [];
                botState.closedTradeKeys = new Set();
                // Map snapshot close entries into closedTrades structure with dedupe keys
                entries.forEach(e => {
                    if (e.t && e.t !== 'close') return;
                    const entry = {
                        id: e.id,
                        symbol: e.symbol,
                        pnl: (e.realizedPnlUsd !== undefined ? e.realizedPnlUsd : (e.pnlUsd || e.pnl || 0)),
                        pnlPercent: (e.realizedPnlPercent !== undefined ? e.realizedPnlPercent : (e.pnlPercent || 0)),
                        entryPrice: e.entryPrice || null,
                        exitPrice: e.exitPrice || null,
                        amount: e.amountSol || e.tokenAmount || 0,
                        openedAt: e.openedAt ? e.openedAt*1000 : null,
                        closedAt: e.closedAt ? e.closedAt*1000 : Date.now()
                    };
                    addClosedTrade(entry, { toFront: false });
                });
                renderTradeHistory();
                addLog('info', `📜 Caricate ${entries.length} trade storici`);
            } else if (data.type === 'trade_history_entry') {
                const e = data.entry || data;
                if (e.t === 'close') {
                    const entry = {
                        id: e.id,
                        symbol: e.symbol,
                        pnl: (e.realizedPnlUsd !== undefined ? e.realizedPnlUsd : (e.pnlUsd || 0)),
                        pnlPercent: (e.realizedPnlPercent !== undefined ? e.realizedPnlPercent : (e.pnlPercent || 0)),
                        entryPrice: e.entryPrice || null,
                        exitPrice: e.exitPrice || null,
                        amount: e.amountSol || e.tokenAmount || 0,
                        openedAt: e.openedAt ? e.openedAt*1000 : null,
                        closedAt: e.closedAt ? e.closedAt*1000 : Date.now()
                    };
                    const added = addClosedTrade(entry, { toFront: true });
                    if (added) renderTradeHistory();
                }
            }
        });
    }
}

// Trade History Rendering
function renderTradeHistory() {
    const tradeHistoryBody = document.getElementById('tradeHistoryBody');
    if (!tradeHistoryBody) return;
    // 1) Read controls
    const tfEl = document.getElementById('historyTimeframe');
    const outEl = document.getElementById('historyOutcomeFilter');
    const searchEl = document.getElementById('historySearch');
    const tf = tfEl ? tfEl.value : 'all';
    const out = outEl ? outEl.value : 'all';
    const q = (searchEl && searchEl.value || '').trim().toLowerCase();
    // 2) Filter
    const now = Date.now();
    let minTs = 0;
    if (tf === '24h') minTs = now - 24*3600*1000;
    else if (tf === '7d') minTs = now - 7*24*3600*1000;
    else if (tf === '30d') minTs = now - 30*24*3600*1000;
    let rows = botState.closedTrades.filter(t => (t.closedAt||0) >= minTs);
    if (out === 'wins') rows = rows.filter(t => (t.pnl ?? 0) >= 0);
    else if (out === 'losses') rows = rows.filter(t => (t.pnl ?? 0) < 0);
    if (q) rows = rows.filter(t => (t.symbol||'').toLowerCase().includes(q));
    // 3) Sorting (remember last sort)
    const table = document.getElementById('tradeHistoryTable');
    const sortKey = table && table.dataset.sortKey || 'closedAt';
    const sortDir = table && table.dataset.sortDir || 'desc';
    const getVal = (t,k)=>{
        switch(k){
            case 'symbol': return t.symbol || '';
            case 'pnlPercent': return (t.pnlPercent!=null)?t.pnlPercent: (t.entryPrice&&t.exitPrice?((t.exitPrice/t.entryPrice-1)*100):0);
            case 'pnl': return t.pnl ?? 0;
            case 'entryPrice': return t.entryPrice ?? 0;
            case 'exitPrice': return t.exitPrice ?? 0;
            case 'amount': return t.amount ?? 0;
            case 'duration': return (t.openedAt && t.closedAt) ? (t.closedAt - t.openedAt) : 0;
            case 'closedAt': return t.closedAt || 0;
            default: return 0;
        }
    };
    rows.sort((a,b)=>{
        const va = getVal(a, sortKey);
        const vb = getVal(b, sortKey);
        if (va<vb) return sortDir==='asc'? -1: 1;
        if (va>vb) return sortDir==='asc'? 1: -1;
        return 0;
    });
    // 4) Render
    tradeHistoryBody.innerHTML = '';
    let wins=0, losses=0, totalPnl=0;
    rows.forEach(trade => {
        const pnlPercent = (trade.pnlPercent!=null) ? trade.pnlPercent : (trade.entryPrice && trade.exitPrice ? ((trade.exitPrice / trade.entryPrice -1)*100):0);
        const durMs = trade.openedAt ? (trade.closedAt - trade.openedAt) : 0;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${trade.symbol}</strong></td>
            <td><span class="${pnlPercent>=0?'pnl-positive':'pnl-negative'} numeric">${pnlPercent>=0?'+':''}${pnlPercent.toFixed(2)}%</span></td>
            <td class="${(trade.pnl??0)>=0?'pnl-positive':'pnl-negative'} numeric">${formatCurrency(trade.pnl??0)}</td>
            <td class="numeric">${trade.entryPrice?formatCurrency(trade.entryPrice):'-'}</td>
            <td class="numeric">${trade.exitPrice?formatCurrency(trade.exitPrice):'-'}</td>
            <td class="numeric">${trade.amount??0}</td>
            <td class="numeric">${formatDuration(durMs)}</td>
            <td class="numeric" title="${new Date(trade.closedAt).toLocaleString()}">${new Date(trade.closedAt).toLocaleTimeString()}</td>`;
        tradeHistoryBody.appendChild(tr);
        // KPIs
        const pnl = trade.pnl ?? 0; totalPnl += pnl; if (pnl>=0) wins++; else losses++;
    });
    // 5) KPIs
    const wrEl = document.getElementById('historyWinRate');
    const tpEl = document.getElementById('historyTotalPnl');
    const apEl = document.getElementById('historyAvgPnl');
    const ctEl = document.getElementById('historyTradesCount');
    const n = rows.length;
    if (wrEl) wrEl.textContent = n? ((wins/n)*100).toFixed(1)+'%':'--';
    if (tpEl) tpEl.textContent = formatCurrency(totalPnl);
    if (apEl) apEl.textContent = n? formatCurrency(totalPnl/n) : '--';
    if (ctEl) ctEl.textContent = String(n);
    closedTradesCount && (closedTradesCount.textContent = botState.closedTrades.length.toString());
}

// History: sorting header handlers and control bindings
document.addEventListener('DOMContentLoaded', () => {
    const table = document.getElementById('tradeHistoryTable');
    function updateHistorySortHeaders(){
        if (!table) return;
        const curKey = table.dataset.sortKey || 'closedAt';
        const curDir = table.dataset.sortDir || 'desc';
        table.querySelectorAll('thead th[data-sort]').forEach(th=>{
            const isActive = th.getAttribute('data-sort') === curKey;
            th.classList.toggle('active', isActive);
            th.classList.toggle('asc', isActive && curDir==='asc');
            th.classList.toggle('desc', isActive && curDir==='desc');
        });
    }
    if (table) {
        table.addEventListener('click', (e)=>{
            const th = e.target.closest('th[data-sort]');
            if (!th) return;
            const key = th.getAttribute('data-sort');
            const curKey = table.dataset.sortKey || 'closedAt';
            const curDir = table.dataset.sortDir || 'desc';
            let dir = 'desc';
            if (key === curKey) dir = (curDir==='desc')? 'asc': 'desc';
            table.dataset.sortKey = key;
            table.dataset.sortDir = dir;
            renderTradeHistory();
            updateHistorySortHeaders();
        });
    }
    const tfEl = document.getElementById('historyTimeframe');
    const outEl = document.getElementById('historyOutcomeFilter');
    const qEl = document.getElementById('historySearch');
    const exportBtn = document.getElementById('historyExportCsv');
    [tfEl,outEl].forEach(el=> el && el.addEventListener('change', renderTradeHistory));
    qEl && qEl.addEventListener('input', ()=> { 
        // lightweight debounce
        clearTimeout(window.__histQDeb); window.__histQDeb = setTimeout(renderTradeHistory, 150);
    });
    exportBtn && exportBtn.addEventListener('click', exportHistoryCsv);
    // Initialize sort header highlight
    updateHistorySortHeaders();
});

function exportHistoryCsv(){
    // Reuse filtered + sorted view
    const table = document.getElementById('tradeHistoryTable');
    const tfEl = document.getElementById('historyTimeframe');
    const outEl = document.getElementById('historyOutcomeFilter');
    const searchEl = document.getElementById('historySearch');
    const tf = tfEl ? tfEl.value : 'all';
    const out = outEl ? outEl.value : 'all';
    const q = (searchEl && searchEl.value || '').trim().toLowerCase();
    const now = Date.now();
    let minTs = 0;
    if (tf === '24h') minTs = now - 24*3600*1000;
    else if (tf === '7d') minTs = now - 7*24*3600*1000;
    else if (tf === '30d') minTs = now - 30*24*3600*1000;
    let rows = botState.closedTrades.filter(t => (t.closedAt||0) >= minTs);
    if (out === 'wins') rows = rows.filter(t => (t.pnl ?? 0) >= 0);
    else if (out === 'losses') rows = rows.filter(t => (t.pnl ?? 0) < 0);
    if (q) rows = rows.filter(t => (t.symbol||'').toLowerCase().includes(q));
    const sortKey = table && table.dataset.sortKey || 'closedAt';
    const sortDir = table && table.dataset.sortDir || 'desc';
    const getVal = (t,k)=>{
        switch(k){
            case 'symbol': return t.symbol || '';
            case 'pnlPercent': return (t.pnlPercent!=null)?t.pnlPercent: (t.entryPrice&&t.exitPrice?((t.exitPrice/t.entryPrice-1)*100):0);
            case 'pnl': return t.pnl ?? 0;
            case 'entryPrice': return t.entryPrice ?? 0;
            case 'exitPrice': return t.exitPrice ?? 0;
            case 'amount': return t.amount ?? 0;
            case 'duration': return (t.openedAt && t.closedAt) ? (t.closedAt - t.openedAt) : 0;
            case 'closedAt': return t.closedAt || 0;
            default: return 0;
        }
    };
    rows.sort((a,b)=>{
        const va = getVal(a, sortKey);
        const vb = getVal(b, sortKey);
        if (va<vb) return sortDir==='asc'? -1: 1;
        if (va>vb) return sortDir==='asc'? 1: -1;
        return 0;
    });
    // Build CSV
    const header = ['Symbol','PnL%','PnL$','Entry','Exit','Amount','Duration','ClosedAt'];
    const lines = [header.join(',')];
    rows.forEach(t=>{
        const pnlPct = (t.pnlPercent!=null)?t.pnlPercent:(t.entryPrice&&t.exitPrice?((t.exitPrice/t.entryPrice-1)*100):0);
        const durMs = (t.openedAt&&t.closedAt)?(t.closedAt-t.openedAt):0;
        const rec = [
            t.symbol || '',
            pnlPct.toFixed(2),
            (t.pnl??0).toFixed(2),
            (t.entryPrice??0).toFixed(8),
            (t.exitPrice??0).toFixed(8),
            (t.amount??0),
            Math.round(durMs/1000)+'s',
            new Date(t.closedAt||0).toISOString()
        ];
        lines.push(rec.join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'trade_history.csv'; a.click();
    setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

// === RADAR 2.0 RENDERING ===
// Configurazione finestra visualizzazione Radar 2.0
let windowSize = 60; // default
function getRadarWindowSize(){
    const sel = document.getElementById('radarWindow');
    if (sel && sel.value) {
        const v = parseInt(sel.value,10);
        if (!isNaN(v) && v>0 && v<10000) { windowSize = v; }
    }
    return windowSize;
}
function computeOpportunityScore(t){
    const safety = Math.max(0, Math.min(100, t.safetyScore || 0));
    const liqFactor = t.liquidity ? Math.min(t.liquidity/150000,1) : 0.3;
    const volFactor = t.volume24h ? Math.min(t.volume24h/500000,1) : 0.3;
    return Math.round(((safety/100)*0.55 + liqFactor*0.25 + volFactor*0.20)*100);
}

function renderRadarTokens(){
    // NOTE: Retained legacy IDs/naming (radarFeed, radar2Count, 'radar' window controls)
    // to avoid widespread refactor risk; user-facing terminology switched to 'Discovery'.
    const container = document.getElementById('radarFeed');
    if(!container) return;
    const countEl = document.getElementById('radar2Count');
    const currentWindow = getRadarWindowSize();
    let tokens = Array.from(botState.foundTokens.values()).slice(-currentWindow).reverse();
    // Sort by opportunity score descending (compute lazily per token for ordering)
    tokens = tokens
        .map(t => ({ t, score: computeOpportunityScore(t) }))
        .sort((a,b)=> b.score - a.score)
        .map(o=> o.t);
    try { addLog('info', `[DISCOVERY] Rendering ${tokens.length} tokens (ordered by opportunity)`); } catch(_){ }
    container.innerHTML='';
    if (tokens.length === 0) {
        container.innerHTML = `
            <div class="discovery-empty">
                <div class="empty-icon"><i class="fas fa-satellite-dish"></i></div>
                <div class="empty-title">Discovery waiting for new tokens…</div>
                <div class="empty-sub">Start the bot or wait for backend events.<br/>No tokens detected yet.</div>
            </div>`;
        if (countEl) countEl.textContent = '0';
        return; // nothing else to render
    }
    tokens.forEach((t)=>{
        const safety = Math.max(0, Math.min(100, t.safetyScore || 0));
        const opportunity = computeOpportunityScore(t);
        const { pct: deltaPct, refSeconds } = computeRecentDelta(t.symbol || t.address || '');
        const lastPrice = t.priceUsd;
        const deltaCls = deltaPct === null ? 'delta-neutral' : (deltaPct>0 ? 'delta-up' : (deltaPct<0 ? 'delta-down':'delta-neutral'));
        const formattedDelta = deltaPct === null ? '--' : `${deltaPct>0?'+':''}${deltaPct.toFixed(2)}%`;
        const row = document.createElement('div');
        row.className = 'token-row';
        row.innerHTML = `
            <div class="token-info">
                <div class="symbol">${t.symbol || '???'}</div>
                <div class="name">${t.name || ''}</div>
                <div class="last-price-badge" data-symbol="${t.symbol}">${formatAdaptivePrice(lastPrice)}</div>
            </div>
            <div class="token-scores">
                <div class="score-block">
                    <div class="score-label"><span><i data-lucide="zap"></i> Opportunity</span><span class="value">${opportunity}%</span></div>
                    <div class="progress-line"><div class="progress-bar opportunity" style="--pct:${opportunity}%;"></div></div>
                </div>
                <div class="score-block">
                    <div class="score-label"><span><i data-lucide="shield-check"></i> Safety</span><span class="value">${safety}%</span></div>
                    <div class="progress-line"><div class="progress-bar safety" style="--pct:${safety}%;"></div></div>
                </div>
            </div>
            <div class="token-metrics">
                <div class="metric"><i data-lucide="wallet"></i><div class="metric-label">Liquidity</div><div class="metric-value">${formatCompact(t.liquidity)}</div></div>
                <div class="metric"><i data-lucide="coins"></i><div class="metric-label">Mkt Cap</div><div class="metric-value">${formatCompact(t.marketCap ?? t.fdv)}</div></div>
                <div class="metric"><i data-lucide="trending-up"></i><div class="metric-label">Vol 24h</div><div class="metric-value">${formatCompact(t.volume24h)}</div></div>
                <div class="metric delta-metric ${deltaCls}"><i data-lucide="activity"></i><div class="metric-label">Δ ${refSeconds||0}s</div><div class="metric-value">${formattedDelta}</div></div>
            </div>
            <div class="token-status">${buildTags(t)}</div>
            <div class="token-action"><button class="snipe-button" data-symbol="${t.symbol}"><i data-lucide="target"></i> SNIPE</button></div>
        `;
        container.appendChild(row);
    });
    if (countEl) countEl.textContent = String(tokens.length);
    // Initialize icons if library loaded
    if (window.lucide?.createIcons) { try { window.lucide.createIcons(); } catch(_){} }
    // Wire SNIPE buttons (stub)
    container.querySelectorAll('.snipe-button').forEach(btn => {
        btn.addEventListener('click', () => {
            const sym = btn.getAttribute('data-symbol');
            addLog('warning', `🎯 Manual snipe requested for ${sym} (stub handler)`);
        });
    });
}

function buildTags(t){
    const tags = [];
    if (t.source === 'Graduated') tags.push('<span class="tag graduated"><i data-lucide="award"></i> Graduated</span>');
    if (t.source === 'Bonding') tags.push('<span class="tag verified"><i data-lucide="check-circle-2"></i> Verified</span>');
    if ((t.volume24h||0) > 500000) tags.push('<span class="tag hot"><i data-lucide="flame"></i> Hot</span>');
    if (t.createdAtMs) {
        const ageH = Math.floor((Date.now()-t.createdAtMs)/3600000);
        if (!isNaN(ageH)) tags.push(`<span class="tag age"><i data-lucide="clock-3"></i> ${ageH}h</span>`);
    }
    return tags.join('');
}

function formatCompact(val){
    if (val === undefined || val === null) return '-';
    if (val >= 1_000_000) return '$'+(val/1_000_000).toFixed(2)+'M';
    if (val >= 1_000) return '$'+(val/1_000).toFixed(1)+'K';
    if (typeof val === 'number') return '$'+val.toFixed(2);
    return String(val);
}

// Sparklines disabilitate (richiesta utente). Manteniamo i listener radar (refresh/pause/window/density).
function queueSparklineRender(){ /* noop */ }

// Throttled auto-refresh hook: re-render Discovery only on new token events when interval allows
const __origAddFoundToken = addFoundToken;
addFoundToken = function(token){
    try {
        __origAddFoundToken(token); // base updates (no direct radar render inside now)
        if (shouldRenderRadar()) {
            try { renderRadarTokens(); } catch(e){ addLog('error', '[DISCOVERY] render error: '+e.message); }
        }
    } catch(err) {
        try { addLog('error','[addFoundToken] fatal: '+err.message); } catch(_){ console.error(err); }
    }
};

// === RADAR RENDER THROTTLE HELPERS ===
let __radarLastRender = 0;
let __radarMinInterval = 350; // ms throttle (più rapido)
function shouldRenderRadar(){
    const now = Date.now();
    if (now - __radarLastRender > __radarMinInterval) {
        __radarLastRender = now;
        return true;
    }
    return false;
}

// Placeholder for legacy updater (prevent errors if called elsewhere)
function updateRenderedRadarRows(){ /* no-op */ }

// === POSITION CARDS RENDERING ===
function renderPositionCards() {
        const grid = document.getElementById('positionCards');
        if (!grid) return;
        grid.innerHTML = '';
        const positions = Array.from(botState.openPositions.values());
    const frag = document.createDocumentFragment();
    positions.forEach(pos => {
                const entryPrice = Number(pos.entryPrice)||0;
                const currentPrice = Number(pos.currentPrice)||entryPrice;
                // Unified PnL logic: prefer displayPnlPercent (renderer normalized), then net, realized (should not exist for open), gross fallback, finally derived.
                let pnlPct;
                if (pos.displayPnlPercent !== undefined && isFinite(pos.displayPnlPercent)) {
                    pnlPct = Number(pos.displayPnlPercent);
                } else if (pos.pnlPercentNet !== undefined && isFinite(pos.pnlPercentNet)) {
                    pnlPct = Number(pos.pnlPercentNet);
                } else if (pos.pnlPercent !== undefined && isFinite(pos.pnlPercent)) {
                    pnlPct = Number(pos.pnlPercent);
                } else if (pos.pnl_percent !== undefined && isFinite(pos.pnl_percent)) {
                    pnlPct = Number(pos.pnl_percent);
                } else if (entryPrice) {
                    pnlPct = ((currentPrice/entryPrice)-1)*100;
                } else {
                    pnlPct = 0;
                }
                if (!isFinite(pnlPct)) pnlPct = 0;
        const tokenAmtScaled = (pos.scaledTokenAmount !== undefined)
            ? pos.scaledTokenAmount
            : (pos.decimals>0 ? (pos.rawTokenAmount||0)/Math.pow(10,pos.decimals) : (pos.tokenAmount||0));
        // USD PnL: prefer displayPnlUsd (net), then pnlUsdNet, then pnlUsd, computed fallback.
        let pnlUsd;
        if (pos.displayPnlUsd !== undefined && isFinite(pos.displayPnlUsd)) {
            pnlUsd = Number(pos.displayPnlUsd);
        } else if (pos.pnlUsdNet !== undefined && isFinite(pos.pnlUsdNet)) {
            pnlUsd = Number(pos.pnlUsdNet);
        } else if (pos.pnlUsd !== undefined && isFinite(pos.pnlUsd)) {
            pnlUsd = Number(pos.pnlUsd);
        } else if (pos.pnl_usd !== undefined && isFinite(pos.pnl_usd)) {
            pnlUsd = Number(pos.pnl_usd);
        } else {
            pnlUsd = tokenAmtScaled*(currentPrice-entryPrice);
        }
                if (!isFinite(pnlUsd)) pnlUsd = 0;
                const pnlCls = pnlPct > 0.5 ? 'pnl-positive' : (pnlPct < -0.5 ? 'pnl-negative' : 'pnl-neutral');
                const hist = botState.priceHistory.get(pos.symbol) || [];
                const svg = buildSparkline(hist);
                const change = entryPrice ? ((currentPrice / entryPrice - 1) * 100) : 0;
                const dexUrl = pos.token_address ? `https://dexscreener.com/solana/${pos.token_address}` : (pos.tokenAddress ? `https://dexscreener.com/solana/${pos.tokenAddress}` : '#');
                const duration = formatRelativeTime(pos.timestamp || Date.now());
                const valueUsd = tokenAmtScaled * currentPrice;
                const valueSol = pos.amountSol ? `${pos.amountSol.toFixed(4)} SOL` : '';
                const card = document.createElement('div');
                card.className = 'trading-card';
                card.innerHTML = `
                    <div class="card-head">
                        <div><span class="symbol">${pos.symbol}</span></div>
                    <div class="pnl-large small ${pnlCls} numeric">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</div>
                    </div>
                <div class="pnl-sub ${pnlCls} numeric">${formatCurrency(pnlUsd)}</div>
                    ${svg}
                    <div class="metrics">
                    <div class="metric"><span class="label">Entry</span><span class="value numeric">${formatAdaptivePrice(entryPrice)}</span></div>
                    <div class="metric"><span class="label">Price</span><span class="value numeric">${formatAdaptivePrice(currentPrice)}</span></div>
                    <div class="metric"><span class="label">Change</span><span class="value ${pnlCls} numeric">${change.toFixed(2)}%</span></div>
                    </div>
                    <div class="metrics">
                    <div class="metric"><span class="label">Tokens</span><span class="value numeric">${tokenAmtScaled ? tokenAmtScaled.toLocaleString(undefined,{maximumFractionDigits:6}) : '-'}</span></div>
                    <div class="metric"><span class="label">Value</span><span class="value numeric">${formatCurrency(valueUsd)}${valueSol?`<br><span style='font-size:.55rem;opacity:.7;'>${valueSol}</span>`:''}</span></div>
                    <div class="metric"><span class="label">Duration</span><span class="value numeric">${duration}</span></div>
                    </div>
                    <div class="card-footer">
                        <div class="card-actions">
                             <button class="action-btn sell" data-action="sell" data-symbol="${pos.symbol}"><i class="fas fa-arrow-down"></i> SELL</button>
                        </div>
                    </div>
                `;
                frag.appendChild(card);
        });
        grid.appendChild(frag);
        grid.querySelectorAll('.card-actions button[data-action="sell"]').forEach(btn => {
                btn.addEventListener('click', () => {
                        const symbol = btn.dataset.symbol;
                        confirmSellPosition(symbol);
                });
        });
}

function buildSparkline(hist) {
        if (!hist || hist.length < 2) return '<svg class="sparkline" viewBox="0 0 100 40"></svg>';
        const vals = hist.map(h=>h.p);
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const span = (max - min) || 1;
        const pts = vals.map((v,i)=>{
                const x = (i/(vals.length-1))*100;
                const y = 40 - ((v - min)/span)*40;
                return x.toFixed(2)+','+y.toFixed(2);
        }).join(' ');
        const first = vals[0];
        const last = vals[vals.length-1];
        let cls = 'positive';
        if (last < first) cls = 'negative'; else if (Math.abs(last-first) < first*0.0001) cls='flat';
        return `<svg class="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none"><polyline points="${pts}" class="${cls}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

function formatDuration(ms) {
    if (!ms) return '-';
    const s = Math.floor(ms/1000);
    if (s < 60) return s+'s';
    const m = Math.floor(s/60);
    if (m < 60) return m+'m';
    const h = Math.floor(m/60);
    return h+'h';
}

// Log updates (global)
if (window.powersol?.onBotLog) {
    window.powersol.onBotLog(logData => {
        addLog(logData.level || 'info', logData.message);
        try {
            if ((logData.level||'').toLowerCase() === 'error') {
                window.badgeManager?.bumpForEvent('log_error');
            }
        } catch(_){ }
    });
}

// Legacy / direct token-found (non structured) channel support
if (window.powersol?.onTokenFound) {
    window.powersol.onTokenFound(t => {
        const normalized = {
            symbol: t.symbol || t.name || 'UNKNOWN',
            name: t.name || t.symbol || 'Unknown Token',
            address: t.address,
            priceUsd: (t.priceUsd !== undefined ? t.priceUsd : (t.price_usd !== undefined ? t.price_usd : (t.price !== undefined ? t.price : 0))),
            liquidity: t.liquidity || 0,
            volume24h: t.volume24h || t.volume_24h || 0,
            safetyScore: t.safetyScore || t.safety_score || 0,
            source: t.source || 'Log'
        };
        addFoundToken(normalized);
    });
}

// === DEMO DATA & ACTIVITY ===
// Retained for optional development testing; no longer auto-called at startup.
function addDemoData() {
    // No-op: demo tokens removed per user request
}

function startDemoActivity() {
    if (!botState.isActive) return;
    
    setTimeout(() => {
        if (botState.isActive) {
            const activities = [
                () => addLog('info', '🔍 Scanning for new tokens...'),
                () => addLog('warning', '⚠️ RPC Error from api.mainnet-beta.solana.com'),
                () => addLog('success', '✅ New token detected'),
                () => addLog('info', '📊 Analyzing token safety score...'),
                () => addLog('warning', '⏰ SELL TRIGGER: STOP LOSS'),
                () => addLog('error', '❌ Failed to execute trade: insufficient balance')
            ];
            
            const randomActivity = activities[Math.floor(Math.random() * activities.length)];
            randomActivity();
            
            startDemoActivity(); // Continue demo activity
        }
    }, Math.random() * 5000 + 2000); // Random interval 2-7 seconds
}

// Safe wrapper to initialize demo data once when backend is unavailable
function setupDemoData() {
    try {
        if (window.__demoSetupDone) return;
        window.__demoSetupDone = true;
        // Seed only if UI is empty to avoid duplicates
        const hasData = (botState.foundTokens.size > 0) || (botState.openPositions.size > 0);
        // No demo seeding; instead, purge legacy demo symbols if they exist
        const legacy = ['SOLDOG','MOONCAT','ROCKET'];
        try {
            for (const [k,v] of botState.foundTokens.entries()) {
                if (v && legacy.includes(v.symbol)) botState.foundTokens.delete(k);
            }
            for (const sym of legacy) {
                if (botState.openPositions.has(sym)) botState.openPositions.delete(sym);
            }
        } catch(_) {}
        try { updateTokensTable(); } catch(_) {}
        try { updateDiscoveryTable(); } catch(_) {}
    schedulePositionsRender();
        // Optional: start background demo log activity only if user started the bot in demo
        // Keep botState.isActive unchanged here; startDemoActivity triggers only when active
    } catch (e) {
        console.warn('setupDemoData error', e);
    }
}

// Advisory if no position events after 2 minutes (real mode only)
function scheduleNoPositionAdvisory() {
    setTimeout(() => {
        if (botState.isActive && botState.positionEvents === 0) {
            addLog('warning', 'ℹ️ No positions detected after 2 minutes.');
            addLog('info', '💡 Ensure the Python bot emits JSON lines for positions:');
            addLog('info', '   {"event":"position_opened","data":{"symbol":"SOLDOG","entryPrice":0.0023,"amount":1000}}');
            addLog('info', '   {"event":"position_closed","data":{"symbol":"SOLDOG","exitPrice":0.0026,"amount":1000}}');
        }
    }, 120000);
}

// Extend startBot to schedule advisory (already wrapped earlier, keep idempotent)
if (!startBot._extendedForAdvisory) {
    const __origStartBot = startBot;
    startBot = async function() {
        await __origStartBot.apply(this, arguments);
        if (botState.isActive) scheduleNoPositionAdvisory();
    };
    startBot._extendedForAdvisory = true;
}

// Final initialization now that all functions exist
async function initialize() {
    try {
        validateCriticalElements();
        setupBotControl();
        setupTabs();
        setupTableSorting();
        setupLogging();
        setupEventListeners();
        setupDiscoveryFilters();
        setupSettings();
        // Wire Panic Sell All button
        const panicBtn = document.getElementById('panicSellAll');
        if (panicBtn) {
            panicBtn.addEventListener('click', async () => {
                const api = window.powersol;
                if (!api) { addLog('error','❌ IPC not available for panic sell'); return; }
                const confirmTxt = '⚠️ PANIC SELL ALL\n\nAll open positions will be sold. Confirm?';
                if (!confirm(confirmTxt)) return;
                addLog('warning','🚨 PANIC SELL ALL started');
                try {
                    // Optimistic UI for panic button
                    const oldHtml = panicBtn.innerHTML;
                    panicBtn.disabled = true;
                    panicBtn.innerHTML = '<i class="fas fa-hourglass-half"></i> RUNNING...';
                    const t0 = (performance?.now)?performance.now():Date.now();
                    if (api.panicSellAll) {
                        const res = await api.panicSellAll();
                        if (!res?.success) {
                            addLog('error','❌ Panic sell all failed: '+(res?.error||'unknown error'));
                        } else {
                            showNotification({ title:'PANIC SELL', message:'Mass sell started', type:'warning', life:6000 });
                            const t1 = (performance?.now)?performance.now():Date.now();
                            addLog('info',`📤 Panic sell all command sent (${(t1-t0).toFixed(0)} ms)`);
                        }
                    } else if (api.sellPosition) {
                        // Fallback: sell individually
                        const symbols = Array.from(botState.openPositions.values()).map(p=>p.symbol).filter(Boolean);
                        if (!symbols.length) { addLog('info','No open positions'); return; }
                        for (const sym of symbols) {
                            try { await api.sellPosition(sym); } catch(_){ }
                        }
                        showNotification({ title:'PANIC SELL', message:'Fallback: individual sells sent', type:'warning', life:6000 });
                        addLog('info','📤 Panic fallback: individual sells sent');
                    } else {
                        addLog('error','❌ No sell API available');
                    }
                } catch(err){
                    addLog('error','❌ Panic sell all error: '+err.message);
                } finally {
                    // Restore panic button
                    panicBtn.disabled = false;
                    panicBtn.innerHTML = '<i class="fas fa-fire"></i> PANIC SELL ALL';
                }
            });
        }
        if (typeof loadSettings === 'function') {
            await loadSettings();
        }
        renderRadarTokens();
        seedStaticPnlPreview();
        // Defer PnL chart until ApexCharts is surely available
        ensureApexChartsLoaded()
            .then(()=>{ initPnlChart(); refreshPnlChart(); })
            .catch(err=>{ 
                addLog('error','❌ ApexCharts not available: '+err.message); 
                const el = document.getElementById('pnl-chart');
                if (el && !el.querySelector('.offline-placeholder')) {
                    el.innerHTML = `<div class="offline-placeholder" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:28px 8px;font-size:.85rem;opacity:.85;">
 <div style=\"font-size:1.6rem;\">📉</div>
 <div><strong>Chart not available offline</strong></div>
 <div style=\"max-width:320px;text-align:center;line-height:1.4;\">Unable to load ApexCharts. Check connection or replace <code>vendor/apexcharts.min.js</code> with the full version.</div>
 <button id=\"retryApex\" class=\"action-btn sec\" style=\"margin-top:6px;\">Retry</button>
 </div>`;
                    const retry = document.getElementById('retryApex');
                    retry && retry.addEventListener('click', ()=>{
                        el.innerHTML = '<div style="padding:24px;opacity:.7;">⏳ Loading chart...</div>';
                        ensureApexChartsLoaded().then(()=>{ initPnlChart(); refreshPnlChart(); }).catch(e2=>{
                            addLog('error','Retry ApexCharts failed: '+e2.message);
                            el.innerHTML += '<div style="margin-top:6px;color:#ff5d7a;">Failed again.</div>';
                        });
                    });
                }
            });
        setupPnlTimeframes();
        if (elements.headerWalletBalance) {
            elements.headerWalletBalance.textContent = '-- SOL';
        }
        updateBotStatus('stopped');
        updateStats(botState.stats);
        renderPositionCards(); // Ensure position cards are rendered at startup
        await checkBotConnection();
        addLog('info', '🚀 Dashboard initialized successfully');
        addLog('info', '📡 Checking Solana connection...');
        addLog('warning', '⏳ Ready to start trading...');
    } catch (error) {
        console.error('Initialization error:', error);
        addLog('error', `❌ Initialization failed: ${error.message}`);
    }
}

// === SETTINGS LOADER (expanded) ===
async function loadSettings() {
    if (!window.powersol?.getSettings) return;
    try {
        const res = await window.powersol.getSettings();
    if (!res?.success) { addLog('warning','⚠️ Unable to load settings: '+(res?.error||'unknown')); return; }
        const s = res.settings || {};
        // Legacy fields first
        if (elements.rpcEndpoint && s.RPC_ENDPOINT !== undefined) elements.rpcEndpoint.value = s.RPC_ENDPOINT;
        if (elements.slippage && s.SLIPPAGE !== undefined) elements.slippage.value = s.SLIPPAGE;
        if (elements.autoSellProfit && s.AUTO_SELL_PROFIT !== undefined) elements.autoSellProfit.value = s.AUTO_SELL_PROFIT;
        if (elements.stopLoss && s.STOP_LOSS !== undefined) elements.stopLoss.value = s.STOP_LOSS;
        // Structured keys
        const structured = [
            'PRIVATE_KEY','MORALIS_API_KEY','HELIUS_API_KEY','BIRDEYE_API_KEY','SOLANA_RPC_PRIMARY','SOLANA_RPC_SECONDARY','SOLANA_RPC_TERTIARY',
            'TRADE_AMOUNT_SOL','MAX_POSITIONS','MIN_SAFETY_SCORE','MIN_VOLUME_24H','MIN_HOLDERS','MIN_LIQUIDITY','TOKEN_AGE_HOURS_MIN','TOKEN_AGE_HOURS_MAX',
            'SCAN_INTERVAL_SECONDS','MAX_TOKENS_PER_SCAN','MONITOR_INTERVAL','PRICE_CACHE_SECONDS','ENABLE_SMART_CACHING',
            'STOP_LOSS_PERCENT','TAKE_PROFIT_PERCENT','TRAILING_STOP_TRIGGER','TRAILING_STOP_PERCENT','FAST_SELL_ENABLED','PANIC_SELL_THRESHOLD','BUY_SLIPPAGE_BPS','SELL_SLIPPAGE_BPS',
            'ENABLE_AUTO_TRADING','ENABLE_REAL_TRADES','ENABLE_SELLS','REQUIRE_VERIFIED_DATA','ENABLE_HONEYPOT_CHECK','ALLOW_UNSAFE_MANUAL_SNIPE','LOG_LEVEL'
        ];
        structured.forEach(k=>{ if (elements[k] && s[k] !== undefined) elements[k].value = s[k]; });
        // Reflect Auto-Trading chip on load
        try {
            const raw = s.ENABLE_AUTO_TRADING;
            const val = (typeof raw === 'string') ? raw.toLowerCase() === 'true' : !!raw;
            updateAutoTradingChip(val);
        } catch(_){ }
    addLog('info','🔧 Settings loaded');
    } catch (e) {
    addLog('error','❌ Settings load error: '+e.message);
    }
}

// Small chip showing Auto-Trading state near Discovery tab
function updateAutoTradingChip(enabled){
    const chip = document.getElementById('autoTradingChip');
    if (!chip) return;
    chip.textContent = enabled ? 'Auto-Trade: ON' : 'Auto-Trade: OFF';
    chip.style.background = enabled ? 'var(--accent-green, #2ecc71)' : 'var(--bg-tertiary)';
    chip.style.color = enabled ? '#0a1e12' : 'var(--text-secondary)';
}

// === BOOTSTRAP ===
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}

// === GLOBAL ERROR HANDLERS & DIAGNOSTICS ===
// Attach only once
if (!window.__powersolDiagInstalled) {
    window.addEventListener('error', (e) => {
        try { addLog('error', `[window.error] ${e.message} @${e.filename||''}:${e.lineno||''}`); } catch(_){}
    });
    window.addEventListener('unhandledrejection', (e) => {
        try { addLog('error', `[unhandledrejection] ${(e.reason&&e.reason.message)||e.reason}`); } catch(_){}
    });
    window._diag = function(){
        const api = window.powersol || {};
        const btn = document.getElementById('botRunButton');
        const summary = {
            timestamp: new Date().toISOString(),
            botState: {
                isActive: botState.isActive,
                startTime: botState.startTime,
                openPositions: botState.openPositions.size,
                foundTokens: botState.foundTokens.size,
                pnlHistoryLen: botState.pnlHistory.length
            },
            apex: !!window.ApexCharts,
            ipc: Object.keys(api),
            startBotFn: typeof api.startBot,
            stopBotFn: typeof api.stopBot,
            getBotStatusFn: typeof api.getBotStatus,
            buttonStateAttr: btn?.getAttribute('data-state') || null,
            buttonExists: !!btn,
            pnlChartExists: !!document.getElementById('pnl-chart'),
            pnlChartInstance: !!window.ApexCharts && !!window.ApexCharts.getChartByID && !!window.ApexCharts.getChartByID('pnlChartMain'),
            radar: {
                lastRender: __radarLastRender || null,
                tokens: botState.foundTokens.size
            }
        };
        try { addLog('info','[diag] '+JSON.stringify(summary)); } catch(_){ console.log('[diag]',summary); }
        return summary;
    };
    window.__powersolDiagInstalled = true;
}

// End of file
    // Closing global scope (added after cleanup)

