const fs = require('fs');
const path = require('path');
const tls = require('tls');
const axios = require('axios');

const GRAPH_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
const DEFAULT_IMAP_HOST = 'outlook.office365.com';

function normalizeEmail(value = '') {
    return String(value || '').trim().toLowerCase();
}

function parseOutlookAccountLine(line = '') {
    const raw = String(line || '').trim();
    if (!raw || raw.startsWith('#')) return null;
    const parts = raw.split('----').map(item => item.trim());
    if (parts.length !== 4) return null;
    const [email, password, clientId, refreshToken] = parts;
    if (!email.includes('@') || !clientId || refreshToken.length < 20) return null;
    return {
        email: normalizeEmail(email),
        password,
        clientId,
        refreshToken,
    };
}

function parseOutlookAccounts(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value
            .map(item => {
                if (typeof item === 'string') return parseOutlookAccountLine(item);
                if (!item || typeof item !== 'object') return null;
                const email = normalizeEmail(item.email);
                const clientId = String(item.clientId || item.client_id || '').trim();
                const refreshToken = String(item.refreshToken || item.refresh_token || '').trim();
                if (!email || !clientId || refreshToken.length < 20) return null;
                return {
                    email,
                    password: String(item.password || ''),
                    clientId,
                    refreshToken,
                };
            })
            .filter(Boolean);
    }
    return String(value || '')
        .split(/\r?\n/)
        .map(parseOutlookAccountLine)
        .filter(Boolean);
}

function decodeQuotedPrintable(input = '') {
    return String(input || '')
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeBody(body = '', transferEncoding = '') {
    const encoding = String(transferEncoding || '').toLowerCase();
    if (encoding.includes('base64')) {
        try {
            return Buffer.from(String(body || '').replace(/\s+/g, ''), 'base64').toString('utf8');
        } catch (error) {
            return body;
        }
    }
    if (encoding.includes('quoted-printable')) {
        return decodeQuotedPrintable(body);
    }
    return body;
}

function parseHeaders(headerText = '') {
    const unfolded = String(headerText || '').replace(/\r?\n[ \t]+/g, ' ');
    const headers = {};
    for (const line of unfolded.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return headers;
}

function splitHeaderBody(raw = '') {
    const match = String(raw || '').match(/\r?\n\r?\n/);
    if (!match) return { headerText: raw, body: '' };
    const idx = match.index;
    return {
        headerText: raw.slice(0, idx),
        body: raw.slice(idx + match[0].length),
    };
}

function getBoundary(contentType = '') {
    const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    return match ? (match[1] || match[2] || '') : '';
}

function extractTextParts(raw = '') {
    const { headerText, body } = splitHeaderBody(raw);
    const headers = parseHeaders(headerText);
    const contentType = headers['content-type'] || '';
    const boundary = getBoundary(contentType);
    const texts = [];

    if (boundary) {
        const marker = `--${boundary}`;
        for (const part of body.split(marker)) {
            if (!part || part.startsWith('--')) continue;
            texts.push(...extractTextParts(part.replace(/^\r?\n/, '')));
        }
        return texts;
    }

    if (/text\/(?:plain|html)/i.test(contentType) || !contentType) {
        texts.push(decodeMimeBody(body, headers['content-transfer-encoding'] || ''));
    }
    return texts;
}

function isOpenAiSender(from = '') {
    const normalized = String(from || '').toLowerCase();
    return [
        'openai.com',
        'auth.openai',
        'tm.openai',
        'chatgpt.com',
        'tm.open',
    ].some(domain => normalized.includes(domain));
}

function isBadShadowSender(from = '') {
    return String(from || '').toLowerCase().includes('tm1.openai');
}

class OutlookAccountPool {
    constructor(options = {}) {
        this.poolFile = options.poolFile || '';
        this.stateFile = options.stateFile || '';
        this.inlineAccounts = Array.isArray(options.accounts) ? options.accounts : [];
        this.records = new Map();
        this.loaded = false;
    }

    _readState() {
        if (!this.stateFile || !fs.existsSync(this.stateFile)) return {};
        try {
            const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.warn(`[OutlookPool] 状态文件解析失败: ${this.stateFile} -> ${error.message}`);
            return {};
        }
    }

    _writeState() {
        if (!this.stateFile) return;
        fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
        const accounts = {};
        for (const [email, record] of this.records.entries()) {
            accounts[email] = record;
        }
        fs.writeFileSync(this.stateFile, JSON.stringify({ accounts }, null, 2));
    }

    _mergeAccount(account) {
        if (!account?.email) return;
        const existing = this.records.get(account.email);
        if (existing) {
            this.records.set(account.email, {
                ...existing,
                ...account,
                status: existing.status || 'available',
                importedAt: existing.importedAt || Date.now(),
            });
            return;
        }
        this.records.set(account.email, {
            ...account,
            status: 'available',
            importedAt: Date.now(),
            claimedAt: null,
            finishedAt: null,
            failReason: '',
        });
    }

    load() {
        if (this.loaded) return;

        const state = this._readState();
        const stateAccounts = state.accounts && typeof state.accounts === 'object'
            ? Object.values(state.accounts)
            : [];
        for (const account of stateAccounts) {
            const email = normalizeEmail(account.email);
            if (!email) continue;
            this.records.set(email, {
                ...account,
                email,
                clientId: account.clientId || account.client_id || '',
                refreshToken: account.refreshToken || account.refresh_token || '',
                status: account.status || 'available',
            });
        }

        if (this.poolFile && fs.existsSync(this.poolFile)) {
            const fromFile = parseOutlookAccounts(fs.readFileSync(this.poolFile, 'utf8'));
            fromFile.forEach(account => this._mergeAccount(account));
        }
        parseOutlookAccounts(this.inlineAccounts).forEach(account => this._mergeAccount(account));

        this.loaded = true;
        this._writeState();
    }

    claimNext() {
        this.load();
        const candidates = [...this.records.values()]
            .filter(item => item.status === 'available')
            .sort((a, b) => Number(a.importedAt || 0) - Number(b.importedAt || 0));
        const record = candidates[0];
        if (!record) {
            throw new Error('[outlook] 号池里没有 available 账号，请导入 email----password----client_id----refresh_token');
        }
        record.status = 'in_use';
        record.claimedAt = Date.now();
        record.failReason = '';
        this.records.set(record.email, record);
        this._writeState();
        return { ...record };
    }

    get(email) {
        this.load();
        const record = this.records.get(normalizeEmail(email));
        return record ? { ...record } : null;
    }

    updateRefreshToken(email, refreshToken) {
        this.load();
        const normalized = normalizeEmail(email);
        const record = this.records.get(normalized);
        if (!record || !refreshToken || record.refreshToken === refreshToken) return;
        record.refreshToken = refreshToken;
        this.records.set(normalized, record);
        this._writeState();
    }

    markDone(email, reason = '') {
        this.load();
        const normalized = normalizeEmail(email);
        const record = this.records.get(normalized);
        if (!record) return;
        record.status = 'done';
        record.finishedAt = Date.now();
        record.failReason = reason || '';
        this.records.set(normalized, record);
        this._writeState();
    }

    markFailed(email, reason = '') {
        this.load();
        const normalized = normalizeEmail(email);
        const record = this.records.get(normalized);
        if (!record || record.status === 'done') return;
        record.status = 'failed';
        record.finishedAt = Date.now();
        record.failReason = String(reason || '').slice(0, 500);
        this.records.set(normalized, record);
        this._writeState();
    }
}

class SimpleImapClient {
    constructor({ host = DEFAULT_IMAP_HOST, port = 993, timeout = 20000 } = {}) {
        this.host = host;
        this.port = port;
        this.timeout = timeout;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.tagId = 0;
    }

    async connect() {
        this.socket = tls.connect({
            host: this.host,
            port: this.port,
            servername: this.host,
        });
        this.socket.on('data', chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('IMAP connect timeout')), this.timeout);
            this.socket.once('secureConnect', () => {
                clearTimeout(timer);
                resolve();
            });
            this.socket.once('error', error => {
                clearTimeout(timer);
                reject(error);
            });
        });
        await this._waitForPattern(/^\* OK/im);
        this.buffer = Buffer.alloc(0);
    }

    _nextTag() {
        this.tagId += 1;
        return `A${String(this.tagId).padStart(4, '0')}`;
    }

    async _waitForPattern(pattern) {
        const started = Date.now();
        while (Date.now() - started < this.timeout) {
            const text = this.buffer.toString('latin1');
            if (pattern.test(text)) return this.buffer;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('IMAP response timeout');
    }

    async command(commandText) {
        const tag = this._nextTag();
        this.buffer = Buffer.alloc(0);
        this.socket.write(`${tag} ${commandText}\r\n`);
        const response = await this._waitForPattern(new RegExp(`^${tag} (?:OK|NO|BAD)`, 'im'));
        const text = response.toString('latin1');
        if (new RegExp(`^${tag} (?:NO|BAD)`, 'im').test(text)) {
            throw new Error(`IMAP command failed: ${commandText} -> ${text.split(/\r?\n/).slice(-3).join(' ')}`);
        }
        return response;
    }

    async authenticateXoauth2(email, accessToken) {
        const tag = this._nextTag();
        this.buffer = Buffer.alloc(0);
        this.socket.write(`${tag} AUTHENTICATE XOAUTH2\r\n`);
        await this._waitForPattern(/^\+/im);
        this.buffer = Buffer.alloc(0);
        const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
        this.socket.write(`${Buffer.from(authString).toString('base64')}\r\n`);
        const response = await this._waitForPattern(new RegExp(`^${tag} (?:OK|NO|BAD)`, 'im'));
        const text = response.toString('latin1');
        if (new RegExp(`^${tag} (?:NO|BAD)`, 'im').test(text)) {
            throw new Error(`IMAP XOAUTH2 failed: ${text.split(/\r?\n/).slice(-3).join(' ')}`);
        }
    }

    async listMailboxes() {
        const response = await this.command('LIST "" "*"');
        const text = response.toString('utf8');
        const names = [];
        for (const line of text.split(/\r?\n/)) {
            if (!line.startsWith('* LIST')) continue;
            const match = line.match(/"([^"]+)"\s*$/) || line.match(/\s([^\s"]+)\s*$/);
            if (match?.[1]) names.push(match[1].replace(/\\"/g, '"'));
        }
        return names;
    }

    async selectMailbox(mailbox) {
        const escaped = String(mailbox || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await this.command(`SELECT "${escaped}"`);
    }

    async searchAll() {
        const response = await this.command('SEARCH ALL');
        const text = response.toString('latin1');
        const match = text.match(/^\* SEARCH\s+(.+)$/im);
        if (!match) return [];
        return match[1].trim().split(/\s+/).filter(Boolean);
    }

    async fetchMessage(id) {
        const response = await this.command(`FETCH ${id} (BODY.PEEK[])`);
        const marker = response.toString('latin1').match(/\{(\d+)\}\r?\n/);
        if (!marker) return Buffer.alloc(0);
        const markerText = marker[0];
        const markerIndex = response.toString('latin1').indexOf(markerText);
        const start = markerIndex + Buffer.byteLength(markerText, 'latin1');
        const length = Number(marker[1]) || 0;
        return response.subarray(start, start + length);
    }

    async logout() {
        if (!this.socket) return;
        try {
            await this.command('LOGOUT');
        } catch (error) {
            // ignore logout errors
        }
        this.socket.end();
    }
}

class OutlookMailClient {
    constructor(options = {}) {
        this.imapHost = options.imapHost || DEFAULT_IMAP_HOST;
        this.imapPort = Number(options.imapPort) || 993;
        this.pool = options.pool || null;
        this.accessTokenCache = new Map();
    }

    async getAccessToken(account) {
        const cached = this.accessTokenCache.get(account.email);
        if (cached && Date.now() - cached.createdAt < 50 * 60 * 1000) {
            return cached.accessToken;
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: account.refreshToken,
            client_id: account.clientId,
            scope: IMAP_SCOPE,
        });
        const response = await axios.post(GRAPH_TOKEN_URL, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000,
        });
        const accessToken = response.data?.access_token;
        if (!accessToken) {
            throw new Error(`[outlook] refresh_token 换 access_token 失败: ${JSON.stringify(response.data || {})}`);
        }
        if (response.data?.refresh_token && this.pool) {
            this.pool.updateRefreshToken(account.email, response.data.refresh_token);
            account.refreshToken = response.data.refresh_token;
        }
        this.accessTokenCache.set(account.email, {
            accessToken,
            createdAt: Date.now(),
        });
        return accessToken;
    }

    _pickFolders(listed = []) {
        const lowerToReal = new Map(listed.map(name => [String(name).toLowerCase(), name]));
        const picked = [];
        for (const name of ['INBOX', 'Junk', 'Junk Email', 'Spam']) {
            const real = lowerToReal.get(name.toLowerCase());
            if (real && !picked.includes(real)) picked.push(real);
        }
        for (const name of listed) {
            const lower = String(name || '').toLowerCase();
            if ((lower.includes('junk') || lower.includes('spam') || lower.includes('bulk')) && !picked.includes(name)) {
                picked.push(name);
            }
        }
        if (!picked.includes('INBOX')) picked.unshift('INBOX');
        return picked;
    }

    _normalizeFetchedMessage(buffer, folder, id) {
        const raw = buffer.toString('utf8');
        const { headerText } = splitHeaderBody(raw);
        const headers = parseHeaders(headerText);
        const text = extractTextParts(raw).join('\n');
        const dateText = headers.date || '';
        const receivedAt = Number.isFinite(Date.parse(dateText))
            ? Math.floor(Date.parse(dateText) / 1000)
            : 0;
        return {
            id: `${folder}:${id}`,
            folder,
            sender: headers.from || '',
            from: headers.from || '',
            subject: headers.subject || '',
            received_at: receivedAt,
            raw,
            text,
            content: text,
        };
    }

    async fetchRecentOpenAiMails(account, { limit = 10, thresholdTs = 0 } = {}) {
        const accessToken = await this.getAccessToken(account);
        const imap = new SimpleImapClient({
            host: this.imapHost,
            port: this.imapPort,
            timeout: 25000,
        });
        const mails = [];
        try {
            await imap.connect();
            await imap.authenticateXoauth2(account.email, accessToken);
            let folders = ['INBOX', 'Junk', 'Junk Email', 'Spam'];
            try {
                folders = this._pickFolders(await imap.listMailboxes());
                console.log(`[Mail][outlook] ${account.email} 扫描目录: ${folders.join(', ')}`);
            } catch (error) {
                console.warn(`[Mail][outlook] LIST 失败，回退默认目录: ${error.message}`);
            }

            for (const folder of folders) {
                try {
                    await imap.selectMailbox(folder);
                    const ids = await imap.searchAll();
                    for (const id of ids.slice(-12).reverse()) {
                        if (mails.length >= limit) break;
                        const mail = this._normalizeFetchedMessage(await imap.fetchMessage(id), folder, id);
                        if (thresholdTs && mail.received_at && mail.received_at < thresholdTs) continue;
                        if (!isOpenAiSender(mail.sender)) continue;
                        if (isBadShadowSender(mail.sender)) {
                            console.log(`[Mail][outlook] 跳过 tm1.openai 影子发码: ${mail.id}`);
                            continue;
                        }
                        mails.push(mail);
                    }
                } catch (error) {
                    console.warn(`[Mail][outlook] 扫描目录失败 ${folder}: ${error.message}`);
                }
            }
        } finally {
            await imap.logout().catch(() => {});
        }
        return mails;
    }
}

module.exports = {
    OutlookAccountPool,
    OutlookMailClient,
    parseOutlookAccountLine,
    parseOutlookAccounts,
};
