const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fssync = require('fs'); // sync helper for existsSync when checking packaged exe
const dotenv = require('dotenv');

class PowerSolGUI {
    constructor() {
        this.mainWindow = null;
        this.botProcess = null;
        this.isDevMode = process.argv.includes('--dev');
        this.noEmoji = process.argv.includes('--no-emoji') || process.env.POWERSOL_NO_EMOJI === '1';
        this.positions = new Map(); // symbol -> position data
        this.stats = { tradesExecuted: 0, salesExecuted: 0, totalPnl: 0 };
        this.backendVersion = 'py-bot-0.1';
        
        // Load environment variables
        dotenv.config();
        
        this.setupApp();
        this.setupIPC();
    }

    setupApp() {
        app.whenReady().then(() => {
            this.createWindow();
            
            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    this.createWindow();
                }
            });
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                this.cleanup();
                app.quit();
            }
        });

        app.on('before-quit', () => {
            this.cleanup();
        });
    }

    createWindow() {
        this.mainWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            minWidth: 1200,
            minHeight: 700,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            icon: path.join(__dirname, 'assets/icon.png')
        });

        this.mainWindow.loadFile(path.join(__dirname, 'index.html'));

        if (this.isDevMode) {
            this.mainWindow.webContents.openDevTools();
        }
    }

    setupIPC() {
        // Bot control
        ipcMain.handle('start-bot', () => this.startBot());
        ipcMain.handle('stop-bot', () => this.stopBot());
        ipcMain.handle('get-bot-status', () => this.getBotStatus());

        // Trading actions
        ipcMain.handle('sell-position', (event, symbol) => this.sellPosition(symbol));
    ipcMain.handle('panic-sell-all', () => this.panicSellAll());
        ipcMain.handle('snipe-token', (event, payload) => this.snipeToken(payload));

        // Settings management
        ipcMain.handle('get-settings', () => this.getSettings());
        ipcMain.handle('save-settings', (event, settings) => this.saveSettings(settings));
        // Generic backend command pipe (JSON line over stdin)
        ipcMain.handle('send-command', (event, payload) => this.sendCommand(payload));
        // History retrieval
        ipcMain.handle('get-trade-history', (event, limit=200) => this.getTradeHistory(limit));
    }

    // === Settings Helpers ===
    async loadEnvSettings() {
        const envPath = path.join(__dirname, '..', '.env');
        try {
            const raw = await fs.readFile(envPath, 'utf8');
            return dotenv.parse(raw);
        } catch (e) {
            // create baseline file with defaults
            const defaults = this.getDefaultSettings();
            await this.writeEnvSettings(defaults);
            return defaults;
        }
    }

    async writeEnvSettings(obj) {
        const envPath = path.join(__dirname, '..', '.env');
        const orderedKeys = this.getOrderedKeys();
        const lines = this.buildEnvHeaderComments();
        for (const k of orderedKeys) {
            if (obj[k] !== undefined && obj[k] !== null) {
                lines.push(`${k}=${obj[k]}`);
            }
        }
        // append any extra keys not in ordering
        Object.keys(obj).filter(k=>!orderedKeys.includes(k)).forEach(k=>{
            lines.push(`${k}=${obj[k]}`);
        });
        await fs.writeFile(envPath, lines.join('\n'));
    }

    getOrderedKeys() {
        return [
            // Wallet & Keys
            'PRIVATE_KEY','MORALIS_API_KEY','HELIUS_API_KEY','BIRDEYE_API_KEY',
            // RPC Endpoints
            'SOLANA_RPC_PRIMARY','SOLANA_RPC_SECONDARY','SOLANA_RPC_TERTIARY',
            // Trading Core
            'TRADE_AMOUNT_SOL','MAX_POSITIONS',
            // Filters / Discovery
            'MIN_SAFETY_SCORE','MIN_VOLUME_24H','MIN_HOLDERS','MIN_LIQUIDITY',
            'TOKEN_AGE_HOURS_MIN','TOKEN_AGE_HOURS_MAX',
            // Execution / Rate & Price Monitoring
            'SCAN_INTERVAL_SECONDS','MAX_TOKENS_PER_SCAN','MONITOR_INTERVAL','PRICE_CACHE_SECONDS','ENABLE_SMART_CACHING',
            // Risk Management
            'STOP_LOSS_PERCENT','TAKE_PROFIT_PERCENT','TRAILING_STOP_TRIGGER','TRAILING_STOP_PERCENT',
            'FAST_SELL_ENABLED','PANIC_SELL_THRESHOLD',
            // Fees & Slippage
            'BUY_SLIPPAGE_BPS','SELL_SLIPPAGE_BPS',
            // Feature Flags
            'ENABLE_REAL_TRADES','ENABLE_AUTO_TRADING','ENABLE_SELLS','REQUIRE_VERIFIED_DATA','ENABLE_HONEYPOT_CHECK','ALLOW_UNSAFE_MANUAL_SNIPE',
            // Signals
            'MICROSTRUCTURE_ENABLED','MIN_TAKER_BUY_RATIO_M5','MIN_TX_M5','MIN_BURST_FACTOR',
            // Logging
            'LOG_LEVEL'
        ];
    }

    getDefaultSettings() {
        return {
            // Wallet/API (empty by default for safety)
            PRIVATE_KEY: '',
            MORALIS_API_KEY: '',
            HELIUS_API_KEY: '',
            BIRDEYE_API_KEY: '',
            // RPC
            SOLANA_RPC_PRIMARY: 'https://api.mainnet-beta.solana.com',
            SOLANA_RPC_SECONDARY: 'https://solana-api.projectserum.com',
            SOLANA_RPC_TERTIARY: 'https://rpc.ankr.com/solana',
            // Trading
            TRADE_AMOUNT_SOL: '0.10',
            MAX_POSITIONS: '1',
            // Filters
            MIN_SAFETY_SCORE: '60',
            MIN_VOLUME_24H: '50000',
            MIN_HOLDERS: '50',
            MIN_LIQUIDITY: '30000',
            TOKEN_AGE_HOURS_MIN: '1',
            TOKEN_AGE_HOURS_MAX: '72',
            // Execution
            SCAN_INTERVAL_SECONDS: '8',
            MAX_TOKENS_PER_SCAN: '30',
            MONITOR_INTERVAL: '6',
            PRICE_CACHE_SECONDS: '20',
            ENABLE_SMART_CACHING: 'true',
            // Risk
            STOP_LOSS_PERCENT: '16.0',
            TAKE_PROFIT_PERCENT: '25.0',
            TRAILING_STOP_TRIGGER: '10.0',
            TRAILING_STOP_PERCENT: '12.0',
            FAST_SELL_ENABLED: 'true',
            PANIC_SELL_THRESHOLD: '12.0',
            // Fees & Slippage
            BUY_SLIPPAGE_BPS: '300',
            SELL_SLIPPAGE_BPS: '500',
            // Feature Flags
            ENABLE_REAL_TRADES: 'false',
            ENABLE_AUTO_TRADING: 'true',
            ENABLE_SELLS: 'true',
            REQUIRE_VERIFIED_DATA: 'true',
            ENABLE_HONEYPOT_CHECK: 'true',
            ALLOW_UNSAFE_MANUAL_SNIPE: 'true',
            // Signals defaults
            MICROSTRUCTURE_ENABLED: 'true',
            MIN_TAKER_BUY_RATIO_M5: '0.58',
            MIN_TX_M5: '10',
            MIN_BURST_FACTOR: '1.5',
            // Logging
            LOG_LEVEL: 'INFO'
        };
    }

    buildEnvHeaderComments() {
        return [
            '# ==== PowerSol Bot Configuration (.env) ====',
            '# Generated/updated automatically by the Electron GUI. Manual edits are allowed.',
            '# NOTES:',
            '#  - PRIVATE_KEY: Wallet private key (NEVER share). GUI masks it; saving preserves masked value.',
            '#  - *_API_KEY: External service API keys (Moralis, Helius, Birdeye).',
            '#  - *_RPC_*: Multiple RPC endpoints for fallback & rotation.',
            '#  - *_SLIPPAGE_BPS: Slippage expressed in basis points (300 = 3%).',
            '#  - *_PERCENT values: Expressed as percentage numbers (e.g. 16.0).',
            '#  - Boolean flags: true/false.',
            '#  - TRADE_AMOUNT_SOL: Default buy size in SOL.',
            '#  - (Rate limiting param semplificati: rimossi MAX_API_REQUESTS_PER_MINUTE e API_REQUEST_DELAY)',
            '#',
            '# Sections:',
            '#  Wallet/API, RPC, Trading, Filters, Execution, Risk, Fees & Slippage, Features, Logging',
            ''
        ];
    }

    sellPosition(symbol) {
        if (!this.botProcess) {
            return { success: false, error: 'Bot not running' };
        }
        try {
            const cmd = JSON.stringify({ cmd: 'sell', symbol, reason: 'GUI_MANUAL' }) + '\n';
            this.botProcess.stdin.write(cmd, 'utf-8');
            return { success: true, message: 'Sell command sent' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    panicSellAll() {
        if (!this.botProcess) {
            return { success: false, error: 'Bot not running' };
        }
        try {
            const cmd = JSON.stringify({ cmd: 'sell_all', reason: 'GUI_PANIC' }) + '\n';
            this.botProcess.stdin.write(cmd, 'utf-8');
            return { success: true, message: 'Panic sell all command sent' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // Generic helper to send an arbitrary JSON command line to backend stdin
    sendCommand(payload) {
        if (!this.botProcess) {
            return { success: false, error: 'Bot not running' };
        }
        try {
            const obj = (payload && typeof payload === 'object') ? payload : { cmd: 'noop' };
            const line = JSON.stringify(obj) + '\n';
            this.botProcess.stdin.write(line, 'utf-8');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    snipeToken(payload) {
        if (!this.botProcess) {
            return { success: false, error: 'Bot not running' };
        }
        try {
            const { symbol, address, amount, preview } = payload || {};
            if (!symbol && !address) {
                return { success:false, error:'Missing symbol or address' };
            }
            const requestId = 'rq_' + Math.random().toString(36).slice(2,10);
            const cmdObj = { cmd: 'snipe', symbol, address, amount, preview: !!preview, reason: 'GUI_MANUAL', request_id: requestId };
            const cmd = JSON.stringify(cmdObj) + '\n';
            this.botProcess.stdin.write(cmd, 'utf-8');
            return { success:true, message:'Snipe command sent', requestId, echo: { symbol, address, amount, preview: !!preview } };
        } catch (e) {
            return { success:false, error:e.message };
        }
    }

    async startBot() {
        if (this.botProcess) {
            return { success: false, error: 'Bot is already running' };
        }

        try {
            // Backend strategy (distribution mode):
            //  - In production (default), ONLY the compiled executable is allowed (no source leakage).
            //  - In dev mode (--dev), we allow falling back to the raw powersol1.py for rapid iteration.
            // This satisfies the requirement: launch without needing powersol1.py for end users.
            const exeName = process.platform === 'win32' ? 'powersol1.exe' : 'powersol1';
            const baseRoot = path.join(__dirname, '..');
            const candidates = [];
            const resourcesRoot = process.resourcesPath ? process.resourcesPath : null;
            if (resourcesRoot) {
                candidates.push(path.join(resourcesRoot, exeName));
                candidates.push(path.join(resourcesRoot, '..', exeName));
                candidates.push(path.join(resourcesRoot, 'native-bin', exeName));
            }
            // Dev / unpacked locations
            candidates.push(path.join(baseRoot, 'dist', exeName));
            candidates.push(path.join(baseRoot, exeName));
            candidates.push(path.join(process.cwd(), exeName));
            // Common subfolder layouts (PyInstaller onedir dropped in project root)
            candidates.push(path.join(baseRoot, 'powersol1', exeName));
            candidates.push(path.join(baseRoot, 'backend', exeName));
            if (resourcesRoot) {
                candidates.push(path.join(resourcesRoot, 'backend', exeName));
                candidates.push(path.join(resourcesRoot, 'dist', exeName));
            }
            // Dev-only Python script fallback candidates
            const scriptCandidate = path.join(baseRoot, 'powersol1.py');
            const scriptCandidateAlt = path.join(process.cwd(), 'powersol1.py');

            let command; let args = []; let cwd = baseRoot; let useFrozen = false; let chosenPath = null;
            for (const c of candidates) {
                try { if (fssync.existsSync(c)) { command = c; chosenPath = c; useFrozen = true; break; } } catch(_){}
            }
            if (!command) {
                // Allow Python script fallback even without --dev if exe is missing
                let scriptPathReal = null;
                if (fssync.existsSync(scriptCandidate)) scriptPathReal = scriptCandidate; else if (fssync.existsSync(scriptCandidateAlt)) scriptPathReal = scriptCandidateAlt;
                if (scriptPathReal) {
                    const pythonPreferred = process.env.POWERSOL_PYTHON || process.env.PYTHON || process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
                    command = pythonPreferred;
                    args = [scriptPathReal, '--auto-start'];
                    if (this.noEmoji) args.push('--no-emoji');
                    chosenPath = scriptPathReal;
                    useFrozen = false;
                }
            }
            if (!command) {
                const diag = { triedExePaths: candidates, lookedForScript: [scriptCandidate, scriptCandidateAlt] };
                this.mainWindow?.webContents.send('bot-log', { type:'error', message:`Backend not found. Place ${exeName} or powersol1.py in app root. Tried: ${JSON.stringify(diag,null,2)}`});
                return { success:false, error:'Backend not found (no powersol1.exe or powersol1.py).' };
            }
            if (useFrozen) {
                this.mainWindow?.webContents.send('bot-log', { type:'info', message:`Using frozen backend: ${chosenPath}`});
                // Ensure the backend's working directory is the exe folder so it finds .env and writes logs nearby
                try { cwd = path.dirname(chosenPath); } catch(_) {}
                // On POSIX systems (macOS/Linux), ensure the binary is executable
                if (process.platform !== 'win32') {
                    try { fssync.chmodSync(chosenPath, 0o755); } catch(_) {}
                }
            } else {
                this.mainWindow?.webContents.send('bot-log', { type:'info', message:`Using Python script backend: ${chosenPath}`});
                // Best effort: surface Python path for diagnostics
                this.mainWindow?.webContents.send('bot-log', { type:'info', message:`Python executable: ${command}`});
            }
            if (this.noEmoji) {
                this.mainWindow?.webContents.send('bot-log', { type:'info', message:'Emoji filter ACTIVE (--no-emoji)' });
            }

            // Note: No integrity probe for frozen backend. Onefile builders (PyInstaller/Nuitka)
            // unpack their runtime at execution time; DLLs are not expected next to the exe.

            const env = { ...process.env };
            // Always force UTF-8 for child process to avoid Windows cp1252/console charmap issues
            // Applies to both frozen exe (embedded Python) and raw Python script
            env.PYTHONIOENCODING = 'utf-8';
            env.PYTHONUTF8 = '1';
            // Helpful locale hints (harmless on Windows if unsupported)
            if (!env.LANG) env.LANG = 'en_US.UTF-8';
            if (!env.LC_ALL) env.LC_ALL = 'C.UTF-8';
            // Keep unbuffered output when running raw Python to improve log responsiveness
            if (!useFrozen) {
                env.PYTHONUNBUFFERED = '1';
            }

            // If exe and want to pass --no-emoji, append (harmless if backend ignores it now; future-ready)
            if (useFrozen) {
                // Always auto-start in production for the frozen backend
                if (!args.includes('--auto-start')) args.push('--auto-start');
                if (this.noEmoji) args.push('--no-emoji');
            }

            this.botProcess = spawn(command, args, {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env
            });

            // Handle standard output
            const stripEmojiIfNeeded = (text) => {
                if (!this.noEmoji) return text;
                // Remove most emoji / symbols outside basic multilingual plane and some pictographs.
                return text.replace(/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
                           .replace(/[\u{1F900}-\u{1F9FF}]/gu,'');
            };
            this.botProcess.stdout.on('data', (data) => {
                const raw = data.toString();
                const processed = this.noEmoji ? stripEmojiIfNeeded(raw) : raw;
                const lines = processed.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    
                    // Check if line contains token information
                    if (line.includes('Found token:')) {
                        try {
                            const tokenMatch = line.match(/Found token: (.*?) \((.*?)\) \[Price: \$(.*?), Vol: \$(.*?), Liq: \$(.*?), Holders: (.*?), Safety: (.*?)\]/);
                            if (tokenMatch) {
                                const [, name, address, price, volume, liquidity, holders, safety] = tokenMatch;
                                const tokenObj = {
                                    name: name,
                                    symbol: name.split(/\s+/)[0].toUpperCase(),
                                    address: address,
                                    price_usd: parseFloat(price),
                                    volume_24h: parseFloat(volume.replace(/,/g, '')),
                                    liquidity: parseFloat(liquidity.replace(/,/g, '')),
                                    holders: parseInt(holders),
                                    safety_score: parseInt(safety),
                                    source: 'log'
                                };
                                this.mainWindow.webContents.send('token-found', tokenObj);
                                // Also forward as structured bot-data for unified handling if desired
                                this.mainWindow.webContents.send('bot-data', { type: 'token_found', token: tokenObj });
                            }
                        } catch (err) {
                            console.error('Error parsing token:', err);
                        }
                    }
                    
                    // Try parse JSON structured messages first
                    let structuredHandled = false;
                    if (line.trim().startsWith('{') && line.trim().endsWith('}')) {
                        try {
                            const obj = JSON.parse(line.trim());
                            if (obj.event === 'token_found') {
                                // Direct token_found structured forwarding
                                this.mainWindow?.webContents.send('bot-data', { type: 'token_found', token: obj.data });
                                structuredHandled = true;
                            } else if (obj.event === 'position_opened') {
                                this.registerOpenPosition(obj.data);
                                structuredHandled = true;
                            } else if (obj.event === 'position_closed') {
                                this.registerClosePosition(obj.data);
                                structuredHandled = true;
                            } else if (obj.event === 'sell_result') {
                                this.mainWindow?.webContents.send('bot-data', { type:'sell_result', result: obj.data });
                                structuredHandled = true;
                            } else if (obj.event === 'snipe_result') {
                                this.mainWindow?.webContents.send('bot-data', { type:'snipe_result', result: obj.data });
                                structuredHandled = true;
                            } else if (obj.event === 'stats_update') {
                                // Normalize backend stats and forward directly; keep a local copy in sync
                                const s = obj.data || {};
                                const normalized = {
                                    totalPnl: Number(s.totalPnl !== undefined ? s.totalPnl : (s.total_pnl ?? this.stats.totalPnl ?? 0)),
                                    realizedPnl: Number(s.realizedPnlUsd !== undefined ? s.realizedPnlUsd : (s.realized_pnl_usd ?? 0)),
                                    unrealizedPnl: Number(s.unrealizedPnlUsd !== undefined ? s.unrealizedPnlUsd : (s.unrealized_pnl_usd ?? 0)),
                                    tradesExecuted: Number(s.tradesExecuted !== undefined ? s.tradesExecuted : (s.trades_executed ?? this.stats.tradesExecuted)),
                                    salesExecuted: Number(s.salesExecuted !== undefined ? s.salesExecuted : (s.real_sells_executed ?? this.stats.salesExecuted)),
                                    activePositions: Number(s.activePositions !== undefined ? s.activePositions : (s.active_positions ?? this.positions.size))
                                };
                                // Update local cache for subsequent emitStats calls
                                this.stats.totalPnl = normalized.totalPnl;
                                this.stats.tradesExecuted = normalized.tradesExecuted;
                                this.stats.salesExecuted = normalized.salesExecuted;
                                // Forward to renderer
                                this.mainWindow?.webContents.send('bot-data', { type: 'stats_update', stats: normalized });
                                structuredHandled = true;
                            } else if (obj.event === 'position_update') {
                                this.mainWindow?.webContents.send('bot-data', { type: 'position_update', position: obj.data });
                                structuredHandled = true;
                            } else if (obj.event === 'batched_price_update') {
                                // Forward aggregated price updates for positions and discovery tokens
                                // Backend emits { updates: [{ symbol, currentPrice, tokenAddress, ts }, ...] }
                                const payload = obj.data && obj.data.updates ? obj.data : { updates: obj.data };
                                this.mainWindow?.webContents.send('bot-data', { type: 'batched_price_update', ...payload });
                                structuredHandled = true;
                            } else if (obj.event === 'trade_history_entry') {
                                this.mainWindow?.webContents.send('bot-data', { type: 'trade_history_entry', entry: obj.data });
                                structuredHandled = true;
                            } else if (obj.event === 'trade_history_snapshot') {
                                this.mainWindow?.webContents.send('bot-data', { type: 'trade_history_snapshot', snapshot: obj.data });
                                structuredHandled = true;
                            } else if (obj.event === 'service_status') {
                                // Frontend no longer displays Jupiter status; ignore this event
                                structuredHandled = true;
                            }
                        } catch (_) { /* ignore */ }
                    }
                    if (!structuredHandled) {
                        // Heuristic parsing for OPEN / CLOSE lines (fallback)
                        this.tryParsePositionHeuristic(line.trim());
                        // Regular log passthrough
                        this.mainWindow?.webContents.send('bot-log', {
                            type: 'info',
                            message: line.trim()
                        });
                    }
                }
            });

            // Handle errors
            this.botProcess.stderr.on('data', (data) => {
                const rawErr = data.toString();
                const processedErr = this.noEmoji ? stripEmojiIfNeeded(rawErr) : rawErr;
                this.mainWindow?.webContents.send('bot-log', {
                    type: 'error',
                    message: processedErr.trim(),
                    timestamp: new Date().toISOString()
                });
            });

            // Handle process exit
            this.botProcess.on('exit', (code) => {
                this.mainWindow?.webContents.send('bot-log', {
                    type: 'status',
                    message: `Bot process exited with code ${code}`,
                    timestamp: new Date().toISOString()
                });
                this.botProcess = null;
            });

            return { 
                success: true, 
                message: `Bot started successfully (${useFrozen ? 'frozen exe' : 'python script'} PID: ${this.botProcess.pid})`
            };
        } catch (error) {
            console.error('Failed to start bot:', error);
            return { success: false, error: error.message };
        }
    }

    async stopBot() {
        if (!this.botProcess) {
            return { success: false, error: 'Bot is not running' };
        }

        try {
            const proc = this.botProcess;
            const waitFor = (ms) => new Promise(res => setTimeout(res, ms));

            // Step 1: Ask nicely via command
            try {
                const cmd = JSON.stringify({ cmd: 'stop' }) + '\n';
                proc.stdin.write(cmd, 'utf-8');
                // Some backends block on stdin; ending stream can unblock
                try { proc.stdin.end(); } catch(_) {}
            } catch (_) { /* ignore */ }

            // Wait up to 2s for graceful exit
            const exited = await new Promise((resolve) => {
                let done = false;
                const onExit = () => { if (!done){ done=true; cleanup(); resolve(true); } };
                const onClose = () => { if (!done){ done=true; cleanup(); resolve(true); } };
                const timer = setTimeout(() => { if (!done){ done=true; cleanup(); resolve(false); } }, 2000);
                const cleanup = () => {
                    proc.off('exit', onExit);
                    proc.off('close', onClose);
                    clearTimeout(timer);
                };
                proc.once('exit', onExit);
                proc.once('close', onClose);
            });

            if (!exited) {
                // Step 2: Try soft kill (SIGTERM)
                try { proc.kill(); } catch(_) {}
                await waitFor(1000);
            }

            let finalExited = exited || proc.killed;
            if (!finalExited) {
                // Step 3: Windows hard kill with taskkill
                if (process.platform === 'win32') {
                    try {
                        const { spawn } = require('child_process');
                        await new Promise((resolve) => {
                            const tk = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
                            tk.on('exit', () => resolve());
                            tk.on('close', () => resolve());
                            setTimeout(() => resolve(), 2000);
                        });
                    } catch(_) {}
                } else {
                    try { proc.kill('SIGKILL'); } catch(_) {}
                }
            }

            this.botProcess = null;
            return { success: true, message: finalExited ? 'Bot stopped gracefully' : 'Bot terminated' };
        } catch (error) {
            console.error('Failed to stop bot:', error);
            return { success: false, error: error.message };
        }
    }

    getBotStatus() {
        const running = this.botProcess !== null && !this.botProcess.killed;
        return {
            running,
            connected: running, // expose connected alias for renderer logic
            pid: this.botProcess?.pid || null,
            version: this.backendVersion
        };
    }

    registerOpenPosition(data) {
        if (!data || !data.symbol) return;
        const position = {
            symbol: data.symbol,
            entryPrice: Number(data.entryPrice || data.price || 0),
            currentPrice: Number(data.currentPrice || data.entryPrice || 0),
            amountSol: Number(data.amountSol || data.amount_sol || 0),
                // Store raw and scaled token amounts for clarity
                tokenAmountRaw: Number(data.tokenAmount || data.amount || 0),
                decimals: Number(data.decimals || data.token_decimals || 0),
                get tokenAmount() { try { return this.tokenAmountRaw / Math.pow(10, this.decimals || 0); } catch(_) { return this.tokenAmountRaw; } },
            entryValueUsd: Number(data.entryValueUsd || data.entry_value_usd || 0),
                rawTokenAmount: Number(data.rawTokenAmount || data.tokenAmount || data.amount || 0),
            timestamp: Date.now()
        };
        this.positions.set(position.symbol, position);
        this.stats.tradesExecuted++;
        this.emitPositionUpdate('position_opened', position);
            // Keep counts fresh; totalPnl is sourced from backend stats_update
            this.emitStats();
    }

    registerClosePosition(data) {
        if (!data || !data.symbol) return;
        const existing = this.positions.get(data.symbol);
            // Use backend-provided realized PnL if available; do NOT recompute locally
            let exitPrice = Number(data.exitPrice || data.price || 0);
        if (existing) {
            if (!exitPrice) exitPrice = existing.currentPrice;
            this.positions.delete(data.symbol);
        }
        this.stats.salesExecuted++;
        this.emitPositionUpdate('position_closed', { 
            symbol: data.symbol, 
                // Forward realized PnL & percent when available from backend; fallback to provided pnl
                pnl: (data.realizedPnlUsd !== undefined ? Number(data.realizedPnlUsd) : Number(data.pnl || 0)), 
                realizedPnlUsd: (data.realizedPnlUsd !== undefined ? Number(data.realizedPnlUsd) : undefined),
                realizedPnlPercent: (data.realizedPnlPercent !== undefined ? Number(data.realizedPnlPercent) : undefined),
                proceedsSol: (data.proceedsSol !== undefined ? Number(data.proceedsSol) : undefined),
                costBasisSol: (data.costBasisSol !== undefined ? Number(data.costBasisSol) : undefined),
            exitPrice: exitPrice || null,
            entryPrice: existing?.entryPrice || null,
                amount: existing?.tokenAmount || data.amount || data.tokenAmount || 0
        });
            // Keep counts fresh; totalPnl remains authoritative from backend stats_update
            this.emitStats();
    }

    updateStats(partial) {
        // Maintain counters and optionally accept trusted totalPnl
        if (partial) {
            if (typeof partial.totalPnl === 'number') this.stats.totalPnl = partial.totalPnl;
            if (typeof partial.tradesExecuted === 'number') this.stats.tradesExecuted = partial.tradesExecuted;
            if (typeof partial.salesExecuted === 'number') this.stats.salesExecuted = partial.salesExecuted;
        }
        this.emitStats();
    }

    emitStats() {
        this.mainWindow?.webContents.send('bot-data', {
            type: 'stats_update',
            stats: {
                tradesExecuted: this.stats.tradesExecuted,
                salesExecuted: this.stats.salesExecuted,
                totalPnl: this.stats.totalPnl,
                activePositions: this.positions.size
            }
        });
    }

    emitPositionUpdate(type, position) {
        this.mainWindow?.webContents.send('bot-data', { type, position });
    }

    async getTradeHistory(limit=200) {
        const historyPath = path.join(__dirname, '..', 'trade_history.jsonl');
        try {
            const stat = await fs.stat(historyPath).catch(()=>null);
            if (!stat) return { success:true, entries: [] };
            const data = await fs.readFile(historyPath, 'utf-8');
            const lines = data.trim().split(/\n+/).slice(-5000); // soft cap
            const closes = [];
            for (let i=lines.length-1; i>=0 && closes.length < limit; i--) {
                const line = lines[i];
                try {
                    const obj = JSON.parse(line);
                    if (obj.t === 'close') closes.push(obj);
                } catch(_){}
            }
            closes.reverse();
            return { success:true, entries: closes };
        } catch (e) {
            return { success:false, error: e.message };
        }
    }

    tryParsePositionHeuristic(line) {
        // Example patterns we try to catch:
        // OPEN POSITION SOLDOG entry=0.00234 amount=1000
        // CLOSE POSITION SOLDOG exit=0.00250 amount=1000 pnl=12.34
        // BUY SOLDOG @0.00234 size=1000
        const openRegex = /(OPEN POSITION|BUY)\s+([A-Z0-9_\.\-]+).*?(entry=|@)([0-9\.]+).*?(amount=|size=)([0-9\.]+)/i;
        const closeRegex = /(CLOSE POSITION|SELL)\s+([A-Z0-9_\.\-]+).*?(exit=|@)([0-9\.]+).*?(amount=|size=)([0-9\.]+)/i;
        if (openRegex.test(line)) {
            const m = line.match(openRegex);
            if (m) {
                this.registerOpenPosition({ symbol: m[2], entryPrice: m[4], amount: m[6] });
            }
        } else if (closeRegex.test(line)) {
            const m = line.match(closeRegex);
            if (m) {
                this.registerClosePosition({ symbol: m[2], exitPrice: m[4], amount: m[6] });
            }
        }
    }

    async getSettings() {
        try {
            const settings = await this.loadEnvSettings();
            // Backward compatibility mapping (legacy keys)
            if (settings.RPC_ENDPOINT && !settings.SOLANA_RPC_PRIMARY) {
                settings.SOLANA_RPC_PRIMARY = settings.RPC_ENDPOINT;
            }
            if (settings.SLIPPAGE && !settings.BUY_SLIPPAGE_BPS) {
                // Convert percent to bps
                const pct = parseFloat(settings.SLIPPAGE);
                if (!isNaN(pct)) settings.BUY_SLIPPAGE_BPS = String(Math.round(pct * 100));
            }
            if (settings.STOP_LOSS && !settings.STOP_LOSS_PERCENT) settings.STOP_LOSS_PERCENT = settings.STOP_LOSS;

            const sensitiveKeys = ['PRIVATE_KEY', 'MORALIS_API_KEY','HELIUS_API_KEY','BIRDEYE_API_KEY'];
            for (const key of sensitiveKeys) {
                if (settings[key]) settings[key] = this.maskSensitiveData(settings[key]);
            }
            return { success: true, settings };
        } catch (error) {
            console.error('Failed to read settings:', error);
            return { success: false, error: error.message };
        }
    }

    async saveSettings(newSettings) {
        try {
            const currentSettings = await this.loadEnvSettings();
            const sensitiveKeys = ['PRIVATE_KEY', 'MORALIS_API_KEY','HELIUS_API_KEY','BIRDEYE_API_KEY'];
            for (const key of sensitiveKeys) {
                if (this.isMasked(newSettings[key])) newSettings[key] = currentSettings[key];
            }

            // Normalize booleans to lower-case strings and trim values
            const booleanKeys = [
                'ENABLE_SMART_CACHING','FAST_SELL_ENABLED','ENABLE_REAL_TRADES','ENABLE_AUTO_TRADING','ENABLE_SELLS',
                'REQUIRE_VERIFIED_DATA','ENABLE_HONEYPOT_CHECK','ALLOW_UNSAFE_MANUAL_SNIPE','MICROSTRUCTURE_ENABLED'
            ];
            for (const b of booleanKeys) {
                if (b in newSettings) {
                    const val = newSettings[b];
                    if (typeof val === 'boolean') newSettings[b] = val ? 'true' : 'false';
                    else newSettings[b] = String(val).toLowerCase() === 'true' ? 'true' : 'false';
                }
            }

            // Backward mapping: if RPC_ENDPOINT provided update primary
            if (newSettings.RPC_ENDPOINT && !newSettings.SOLANA_RPC_PRIMARY) {
                newSettings.SOLANA_RPC_PRIMARY = newSettings.RPC_ENDPOINT;
            }
            if (newSettings.SLIPPAGE && !newSettings.BUY_SLIPPAGE_BPS) {
                const pct = parseFloat(newSettings.SLIPPAGE);
                if (!isNaN(pct)) newSettings.BUY_SLIPPAGE_BPS = String(Math.round(pct * 100));
            }
            if (newSettings.STOP_LOSS && !newSettings.STOP_LOSS_PERCENT) newSettings.STOP_LOSS_PERCENT = newSettings.STOP_LOSS;

            // Remove empty strings for numeric settings so defaults remain in effect
            const numericKeys = [
                'BUY_SLIPPAGE_BPS','SELL_SLIPPAGE_BPS','STOP_LOSS_PERCENT','TAKE_PROFIT_PERCENT',
                'TRAILING_STOP_TRIGGER','TRAILING_STOP_PERCENT','PANIC_SELL_THRESHOLD','TRADE_AMOUNT_SOL',
                // Microstructure numeric keys
                'MIN_TAKER_BUY_RATIO_M5','MIN_TX_M5','MIN_BURST_FACTOR'
            ];
            for (const nk of numericKeys) {
                if (nk in newSettings && (newSettings[nk] === '' || newSettings[nk] == null)) {
                    delete newSettings[nk];
                }
            }
            // Fee percentage removed from public config; backend retains internal default.

            const defaults = this.getDefaultSettings();
            const merged = { ...defaults, ...currentSettings, ...newSettings };
            await this.writeEnvSettings(merged);
            return { success:true, message:'Settings saved successfully. Alcune modifiche richiedono riavvio del bot.' };
        } catch (error) {
            console.error('Failed to save settings:', error);
            return { success:false, error:error.message };
        }
    }

    maskSensitiveData(value) {
        if (!value) return '';
        if (value.length <= 8) return '*'.repeat(value.length);
        return value.substring(0, 4) + '*'.repeat(value.length - 8) + value.substring(value.length - 4);
    }

    isMasked(value) {
        return value && value.includes('*');
    }

    cleanup() {
        if (this.botProcess) {
            this.botProcess.kill();
            this.botProcess = null;
        }
    }
}

new PowerSolGUI();