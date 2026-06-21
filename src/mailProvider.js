const axios = require('axios');
const { randomInt } = require('node:crypto');
const { OutlookAccountPool, OutlookMailClient } = require('./outlookMail');

class MailProvider {
    constructor(options) {
        this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
        this.adminPassword = options.adminPassword;
        this.sitePassword = options.sitePassword || '';
        this.domain = options.domain;
        this.provider = String(options.provider || 'auto').toLowerCase(); // auto | legacy | cloud-mail | cloudflare-worker | outlook
        this.adminEmail = options.adminEmail || '';
        this.adminToken = options.adminToken || '';
        this.userType = Number(options.userType) || 1;
        this.outlookPoolFile = options.outlookPoolFile || '';
        this.outlookPoolStateFile = options.outlookPoolStateFile || '';
        this.outlookAccounts = Array.isArray(options.outlookAccounts) ? options.outlookAccounts : [];
        this.outlookImapHost = options.outlookImapHost || '';
        this.outlookImapPort = Number(options.outlookImapPort) || 993;
        this.outlookPool = null;
        this.outlookClient = null;
        this.outlookAccount = null;
        this.outlookOtpThresholdTs = 0;
        this.outlookAddressThresholds = new Map();
        this.outlookAddressFinalized = false;
        this.jwt = null;
        this.address = null;
        this.addressId = null;
        this.addressPassword = null;
        this.addressSessionCache = new Map();
        this.sessionLookupTried = new Set();
    }

    _adminHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            'x-admin-auth': this.adminPassword,
        };
        if (this.sitePassword) {
            headers['x-custom-auth'] = this.sitePassword;
        }
        return headers;
    }

    _addressHeaders() {
        const headers = {};
        if (this.provider === 'cloud-mail') {
            headers['Authorization'] = this.jwt;
        } else {
            headers['Authorization'] = `Bearer ${this.jwt}`;
            if (this.sitePassword) {
                headers['x-custom-auth'] = this.sitePassword;
            }
        }
        return headers;
    }

    _cloudHeaders(token) {
        return {
            'Content-Type': 'application/json',
            'Authorization': token,
        };
    }

    _cloudflareWorkerHeaders() {
        const token = this.adminToken || this.adminPassword || '';
        const headers = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    _normalizeAddress(address) {
        return String(address || '').trim().toLowerCase();
    }

    _normalizeDomainSuffix(domain) {
        const normalized = String(domain || '').trim().toLowerCase();
        if (!normalized) return '';
        return normalized.startsWith('@') ? normalized : `@${normalized}`;
    }

    _extractAddressParts(address) {
        const normalized = String(address || '').trim();
        const at = normalized.lastIndexOf('@');
        if (at <= 0 || at === normalized.length - 1) return null;
        return {
            name: normalized.slice(0, at),
            domain: normalized.slice(at + 1),
            full: normalized,
        };
    }

    _extractMailsFromPayload(payload) {
        if (!payload) return null;
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload.results)) return payload.results;
        if (Array.isArray(payload.mails)) return payload.mails;
        if (payload.data) {
            if (Array.isArray(payload.data)) return payload.data;
            if (Array.isArray(payload.data.results)) return payload.data.results;
            if (Array.isArray(payload.data.mails)) return payload.data.mails;
        }
        return null;
    }

    _extractSessionFromPayload(payload, address) {
        if (!payload || typeof payload !== 'object') return null;
        const jwt = payload.jwt || payload.token || payload.access_token || payload?.data?.jwt || payload?.data?.token;
        if (!jwt) return null;

        const resolvedAddress = payload.address || payload.email || payload?.data?.address || payload?.data?.email || address;
        const addressId = payload.address_id || payload.addressId || payload?.data?.address_id || payload?.data?.addressId || null;
        return {
            address: resolvedAddress,
            jwt,
            addressId,
        };
    }

    _unwrapCloudResponse(responseData, action = 'cloud-mail request') {
        if (!responseData || typeof responseData !== 'object') return responseData;
        if (responseData.code === 200) {
            return responseData.data;
        }
        if (typeof responseData.code !== 'undefined') {
            const msg = responseData.message || `${action} failed`;
            throw new Error(`[cloud-mail] ${msg} (code=${responseData.code})`);
        }
        return responseData;
    }

    _looksLikeLegacyMismatch(error) {
        const status = error?.response?.status;
        const body = error?.response?.data;
        if (status === 404 || status === 405) return true;
        if (typeof body === 'string' && /<!doctype html|<html/i.test(body)) return true;
        return false;
    }

    _normalizeCloudMailRows(rows = []) {
        return rows.map((item) => {
            const content = String(item?.content || '');
            const text = String(item?.text || '');
            const subject = String(item?.subject || '');
            const raw = String(item?.raw || '').trim() || [subject, text, content].filter(Boolean).join('\n\n');
            return { ...item, raw };
        });
    }

    _cacheCurrentSession() {
        const key = this._normalizeAddress(this.address);
        if (!key || !this.jwt) return;
        this.addressSessionCache.set(key, {
            address: this.address,
            jwt: this.jwt,
            addressId: this.addressId || null,
            password: this.addressPassword || null,
        });
    }

    _loadSessionFromCache(address) {
        const key = this._normalizeAddress(address);
        if (!key) return false;
        const cached = this.addressSessionCache.get(key);
        if (!cached) return false;
        this.useExistingAddressSession(cached);
        return true;
    }

    _randomName() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const length = 8 + randomInt(5); // 8-12
        let name = '';
        for (let i = 0; i < length; i++) {
            name += chars[randomInt(chars.length)];
        }
        return name;
    }

    _randomPassword(length = 14) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$';
        let out = '';
        for (let i = 0; i < length; i++) {
            out += chars[randomInt(chars.length)];
        }
        return `${out}A1!`;
    }

    _ensureOutlook() {
        if (!this.outlookPool) {
            this.outlookPool = new OutlookAccountPool({
                poolFile: this.outlookPoolFile,
                stateFile: this.outlookPoolStateFile,
                accounts: this.outlookAccounts,
            });
        }
        if (!this.outlookClient) {
            this.outlookClient = new OutlookMailClient({
                imapHost: this.outlookImapHost,
                imapPort: this.outlookImapPort,
                pool: this.outlookPool,
            });
        }
    }

    async _ensureCloudAdminToken() {
        if (this.adminToken) return this.adminToken;

        let email = String(this.adminEmail || '').trim();
        const password = String(this.adminPassword || '').trim();

        // 兼容历史配置：有些部署会把 admin 邮箱和密码都设成同一个邮箱字符串
        if (!email && password.includes('@')) {
            email = password;
            console.log('[Mail][cloud-mail] 未配置 mailAdminEmail，回退为 mailAdminPassword');
        }

        if (!email || !password) {
            throw new Error('[cloud-mail] 缺少管理员登录信息，请配置 mailAdminEmail + mailAdminPassword 或 mailAdminToken');
        }

        const response = await axios.post(
            `${this.baseUrl}/api/login`,
            { email, password },
            { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        );
        const data = this._unwrapCloudResponse(response.data, 'login');
        const token = data?.token || data?.jwt || '';
        if (!token) {
            throw new Error('[cloud-mail] /api/login 未返回 token');
        }
        this.adminToken = token;
        return token;
    }

    async _createAddressLegacy(name = null) {
        const emailName = name || this._randomName();
        const response = await axios.post(
            `${this.baseUrl}/admin/new_address`,
            { name: emailName, domain: this.domain, enablePrefix: false },
            { headers: this._adminHeaders(), timeout: 15000 }
        );

        const data = response.data;
        if (!data?.jwt || !data?.address) {
            throw new Error('legacy provider response missing jwt/address');
        }

        this.jwt = data.jwt;
        this.address = data.address;
        this.addressId = data.address_id || null;
        this.addressPassword = null;
        this._cacheCurrentSession();

        console.log(`[Mail] 创建邮箱: ${this.address}`);
        return { jwt: this.jwt, address: this.address, addressId: this.addressId };
    }

    async _createAddressCloudMail(name = null) {
        const adminToken = await this._ensureCloudAdminToken();
        const emailName = name || this._randomName();
        const domainSuffix = this._normalizeDomainSuffix(this.domain);
        if (!domainSuffix) {
            throw new Error('[cloud-mail] mailDomain 为空，无法创建邮箱地址');
        }
        const email = `${emailName}${domainSuffix}`;
        const mailboxPassword = this._randomPassword();

        await axios.post(
            `${this.baseUrl}/api/user/add`,
            {
                email,
                suffix: domainSuffix,
                password: mailboxPassword,
                type: this.userType,
            },
            {
                headers: this._cloudHeaders(adminToken),
                timeout: 20000,
            }
        ).then((res) => this._unwrapCloudResponse(res.data, 'user/add'));

        const loginRes = await axios.post(
            `${this.baseUrl}/api/login`,
            { email, password: mailboxPassword },
            { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        );
        const loginData = this._unwrapCloudResponse(loginRes.data, 'login(new mailbox)');
        const userToken = loginData?.token || loginData?.jwt || '';
        if (!userToken) {
            throw new Error('[cloud-mail] 新邮箱登录未返回 token');
        }

        const infoRes = await axios.get(
            `${this.baseUrl}/api/my/loginUserInfo`,
            {
                headers: this._cloudHeaders(userToken),
                timeout: 15000,
            }
        );
        const userInfo = this._unwrapCloudResponse(infoRes.data, 'my/loginUserInfo');
        const accountId = userInfo?.account?.accountId || userInfo?.accountId || null;

        this.jwt = userToken;
        this.address = email;
        this.addressId = accountId;
        this.addressPassword = mailboxPassword;
        this._cacheCurrentSession();

        console.log(`[Mail][cloud-mail] 创建邮箱: ${this.address}`);
        return { jwt: this.jwt, address: this.address, addressId: this.addressId };
    }

    async _createAddressCloudflareWorker(name = null) {
        const emailName = name || this._randomName();
        const domain = String(this.domain || '').trim().replace(/^@/, '');
        if (!domain) {
            throw new Error('[cloudflare-worker] mailDomain 为空，无法生成邮箱地址');
        }

        const response = await axios.post(
            `${this.baseUrl}/api/create-address`,
            { name: emailName, domain },
            {
                headers: this._cloudflareWorkerHeaders(),
                timeout: 15000,
            }
        );

        const address = response.data?.address || `${emailName}@${domain}`;
        this.jwt = this.adminToken || this.adminPassword || 'cloudflare-worker';
        this.address = address;
        this.addressId = response.data?.id || null;
        this.addressPassword = null;
        this._cacheCurrentSession();

        console.log(`[Mail][cloudflare-worker] 创建邮箱: ${this.address}`);
        return { jwt: this.jwt, address: this.address, addressId: this.addressId };
    }

    async _createAddressOutlook() {
        this._ensureOutlook();
        const account = this.outlookPool.claimNext();
        this.outlookAccount = account;
        this.jwt = 'outlook-imap-oauth2';
        this.address = account.email;
        this.addressId = account.email;
        this.addressPassword = account.password || null;
        this.outlookOtpThresholdTs = Math.floor(Date.now() / 1000) - 5;
        this.outlookAddressFinalized = false;
        this._cacheCurrentSession();

        console.log(`[Mail][outlook] 从号池取用邮箱: ${this.address}`);
        return { jwt: this.jwt, address: this.address, addressId: this.addressId };
    }

    async createAddress(name = null) {
        if (this.provider === 'outlook') {
            return await this._createAddressOutlook();
        }
        if (this.provider === 'legacy') {
            return await this._createAddressLegacy(name);
        }
        if (this.provider === 'cloud-mail') {
            return await this._createAddressCloudMail(name);
        }
        if (this.provider === 'cloudflare-worker') {
            return await this._createAddressCloudflareWorker(name);
        }

        // auto mode: 优先 legacy，不兼容时自动切 cloud-mail
        try {
            const created = await this._createAddressLegacy(name);
            this.provider = 'legacy';
            return created;
        } catch (error) {
            if (!this._looksLikeLegacyMismatch(error)) {
                throw error;
            }
            console.warn('[Mail] legacy 邮箱接口不兼容，自动切换 cloud-mail 协议');
            this.provider = 'cloud-mail';
            return await this._createAddressCloudMail(name);
        }
    }

    useExistingAddressSession(session = {}) {
        const { address, jwt, addressId, password } = session;
        if (!address || !jwt) {
            throw new Error('邮箱会话信息不完整，无法复用');
        }
        this.address = address;
        this.jwt = jwt;
        this.addressId = addressId || null;
        this.addressPassword = password || null;
        this._cacheCurrentSession();
        console.log(`[Mail] 已复用邮箱会话: ${this.address}`);
    }

    getInboxUrl() {
        if (this.provider === 'outlook') {
            return 'https://outlook.live.com/mail/0/inbox';
        }
        if (this.provider === 'cloud-mail') {
            return `${this.baseUrl}/`;
        }
        if (this.provider === 'cloudflare-worker') {
            return `${this.baseUrl}/`;
        }
        return `${this.baseUrl}/?jwt=${this.jwt}`;
    }

    getEmail() {
        return this.address;
    }

    async _getMailsLegacy(limit = 10, offset = 0) {
        const response = await axios.get(
            `${this.baseUrl}/api/mails`,
            {
                params: { limit, offset },
                headers: this._addressHeaders(),
                timeout: 15000,
            }
        );
        return response.data.results || [];
    }

    async _hydrateCloudAccountId() {
        if (this.addressId) return;
        if (!this.jwt) return;
        try {
            const response = await axios.get(
                `${this.baseUrl}/api/my/loginUserInfo`,
                {
                    headers: this._cloudHeaders(this.jwt),
                    timeout: 15000,
                }
            );
            const userInfo = this._unwrapCloudResponse(response.data, 'my/loginUserInfo');
            this.addressId = userInfo?.account?.accountId || userInfo?.accountId || null;
        } catch (error) {
            // ignore, caller will handle missing accountId
        }
    }

    async _getMailsCloudMail(limit = 10) {
        if (!this.jwt) {
            throw new Error('[cloud-mail] 当前邮箱会话不存在，无法获取邮件');
        }

        await this._hydrateCloudAccountId();
        if (!this.addressId) {
            throw new Error('[cloud-mail] accountId 不存在，无法查询邮件');
        }

        const response = await axios.get(
            `${this.baseUrl}/api/email/list`,
            {
                params: {
                    accountId: this.addressId,
                    type: 0,         // RECEIVE
                    size: Math.max(1, Math.min(50, Number(limit) || 10)),
                    emailId: 0,
                    timeSort: 0,
                    allReceive: 0,
                },
                headers: this._cloudHeaders(this.jwt),
                timeout: 20000,
            }
        );

        const data = this._unwrapCloudResponse(response.data, 'email/list');
        const rows = Array.isArray(data?.list) ? data.list : [];
        return this._normalizeCloudMailRows(rows);
    }

    async _getMailsCloudflareWorker(limit = 10, offset = 0) {
        if (!this.address) {
            throw new Error('[cloudflare-worker] 当前邮箱地址不存在，无法获取邮件');
        }
        return await this._getMailsByAddressCloudflareWorker(this.address, limit, offset);
    }

    async _getMailsOutlook(limit = 10) {
        if (!this.address) {
            throw new Error('[outlook] 当前邮箱地址不存在，无法获取邮件');
        }
        return await this._getMailsByAddressOutlook(this.address, limit);
    }

    async getMails(limit = 10, offset = 0) {
        if (this.provider === 'outlook') {
            return await this._getMailsOutlook(limit);
        }
        if (this.provider === 'cloud-mail') {
            return await this._getMailsCloudMail(limit);
        }
        if (this.provider === 'cloudflare-worker') {
            return await this._getMailsCloudflareWorker(limit, offset);
        }
        return await this._getMailsLegacy(limit, offset);
    }

    async _tryCreateAddressSession(address) {
        const normalized = this._normalizeAddress(address);
        if (!normalized) return false;
        if (this.sessionLookupTried.has(normalized)) return false;
        this.sessionLookupTried.add(normalized);

        const parts = this._extractAddressParts(address);
        if (!parts) return false;
        if (this.domain && parts.domain.toLowerCase() !== String(this.domain).toLowerCase()) return false;

        try {
            const created = await this.createAddress(parts.name);
            const createdAddress = this._normalizeAddress(created?.address);
            if (createdAddress === normalized) {
                return true;
            }
        } catch (error) {
            // ignore and continue fallback
        }
        return false;
    }

    async _tryFetchSessionByAdmin(address) {
        const candidates = [
            { method: 'get', url: '/admin/address', params: { address } },
            { method: 'get', url: '/admin/address', params: { email: address } },
            { method: 'post', url: '/admin/address', data: { address } },
            { method: 'post', url: '/admin/get_address', data: { address } },
            { method: 'post', url: '/admin/get_address', data: { email: address } },
            { method: 'post', url: '/admin/get_address_session', data: { address } },
            { method: 'post', url: '/admin/address_session', data: { address } },
        ];

        for (const candidate of candidates) {
            try {
                const response = await axios({
                    method: candidate.method,
                    url: `${this.baseUrl}${candidate.url}`,
                    params: candidate.params,
                    data: candidate.data,
                    headers: this._adminHeaders(),
                    timeout: 15000,
                });
                const session = this._extractSessionFromPayload(response.data, address);
                if (session && this._normalizeAddress(session.address) === this._normalizeAddress(address)) {
                    this.useExistingAddressSession(session);
                    return true;
                }
            } catch (error) {
                // try next
            }
        }
        return false;
    }

    async _fetchMailsByAdmin(address, limit, offset) {
        const candidates = [
            { method: 'get', url: '/admin/mails', params: { address, limit, offset } },
            { method: 'get', url: '/admin/mails', params: { email: address, limit, offset } },
            { method: 'post', url: '/admin/mails', data: { address, limit, offset } },
            { method: 'get', url: '/admin/get_mails', params: { address, limit, offset } },
            { method: 'get', url: '/api/mails', params: { address, limit, offset } },
            { method: 'get', url: '/api/mails', params: { email: address, limit, offset } },
        ];

        let lastError = null;
        for (const candidate of candidates) {
            try {
                const response = await axios({
                    method: candidate.method,
                    url: `${this.baseUrl}${candidate.url}`,
                    params: candidate.params,
                    data: candidate.data,
                    headers: this._adminHeaders(),
                    timeout: 15000,
                });
                const mails = this._extractMailsFromPayload(response.data);
                if (Array.isArray(mails)) {
                    return mails;
                }
                const session = this._extractSessionFromPayload(response.data, address);
                if (session) {
                    this.useExistingAddressSession(session);
                    return await this.getMails(limit, offset);
                }
            } catch (error) {
                lastError = error;
            }
        }

        if (lastError) throw lastError;
        return [];
    }

    async _getMailsByAddressCloudMail(address, limit = 10) {
        const normalized = this._normalizeAddress(address);
        if (!normalized) {
            throw new Error('email is empty');
        }

        if (this._normalizeAddress(this.address) === normalized && this.jwt) {
            return await this._getMailsCloudMail(limit);
        }

        if (this._loadSessionFromCache(normalized)) {
            return await this._getMailsCloudMail(limit);
        }

        const adminToken = await this._ensureCloudAdminToken();
        const response = await axios.get(
            `${this.baseUrl}/api/allEmail/list`,
            {
                params: {
                    type: 'receive',
                    accountEmail: normalized,
                    size: Math.max(1, Math.min(50, Number(limit) || 10)),
                    emailId: 0,
                    timeSort: 0,
                },
                headers: this._cloudHeaders(adminToken),
                timeout: 20000,
            }
        );
        const data = this._unwrapCloudResponse(response.data, 'allEmail/list');
        const rows = Array.isArray(data?.list) ? data.list : [];
        return this._normalizeCloudMailRows(rows);
    }

    async _getMailsByAddressCloudflareWorker(address, limit = 10, offset = 0) {
        const normalized = this._normalizeAddress(address);
        if (!normalized) {
            throw new Error('email is empty');
        }

        const response = await axios.get(
            `${this.baseUrl}/api/mails`,
            {
                params: {
                    address: normalized,
                    limit: Math.max(1, Math.min(50, Number(limit) || 10)),
                    offset: Math.max(0, Number(offset) || 0),
                },
                headers: this._cloudflareWorkerHeaders(),
                timeout: 15000,
            }
        );
        const mails = this._extractMailsFromPayload(response.data) || [];
        return this._normalizeCloudMailRows(mails);
    }

    async _getMailsByAddressOutlook(address, limit = 10) {
        const normalized = this._normalizeAddress(address);
        if (!normalized) {
            throw new Error('email is empty');
        }
        this._ensureOutlook();

        let account = null;
        if (this._normalizeAddress(this.outlookAccount?.email) === normalized) {
            account = this.outlookAccount;
        } else {
            account = this.outlookPool.get(normalized);
        }
        if (!account) {
            throw new Error(`[outlook] 号池中找不到邮箱凭证: ${normalized}`);
        }

        const thresholdTs = this.outlookAddressThresholds.get(normalized)
            || (this._normalizeAddress(this.address) === normalized ? this.outlookOtpThresholdTs : 0);
        const mails = await this.outlookClient.fetchRecentOpenAiMails(account, {
            limit: Math.max(1, Math.min(50, Number(limit) || 10)),
            thresholdTs,
        });
        return this._normalizeCloudMailRows(mails);
    }

    async getMailsByAddress(address, limit = 10, offset = 0) {
        if (this.provider === 'outlook') {
            return await this._getMailsByAddressOutlook(address, limit);
        }
        if (this.provider === 'cloud-mail') {
            return await this._getMailsByAddressCloudMail(address, limit);
        }
        if (this.provider === 'cloudflare-worker') {
            return await this._getMailsByAddressCloudflareWorker(address, limit, offset);
        }

        const normalized = this._normalizeAddress(address);
        if (!normalized) {
            throw new Error('email is empty');
        }

        if (this._normalizeAddress(this.address) === normalized && this.jwt) {
            return await this.getMails(limit, offset);
        }

        if (this._loadSessionFromCache(normalized)) {
            return await this.getMails(limit, offset);
        }

        const hasSession = await this._tryCreateAddressSession(normalized) || await this._tryFetchSessionByAdmin(normalized);
        if (hasSession && this._normalizeAddress(this.address) === normalized && this.jwt) {
            return await this.getMails(limit, offset);
        }

        return await this._fetchMailsByAdmin(normalized, limit, offset);
    }

    noteOtpRequested(address = null) {
        if (this.provider !== 'outlook') return;
        const target = this._normalizeAddress(address || this.address);
        if (!target) return;
        const threshold = Math.floor(Date.now() / 1000) - 5;
        this.outlookAddressThresholds.set(target, threshold);
        if (target === this._normalizeAddress(this.address)) {
            this.outlookOtpThresholdTs = threshold;
        }
    }

    markAddressDone(reason = '') {
        if (this.provider !== 'outlook' || !this.address || this.outlookAddressFinalized) return;
        this._ensureOutlook();
        this.outlookPool.markDone(this.address, reason);
        this.outlookAddressFinalized = true;
        console.log(`[Mail][outlook] 号池状态更新为 done: ${this.address}`);
    }

    markAddressFailed(reason = '') {
        if (this.provider !== 'outlook' || !this.address || this.outlookAddressFinalized) return;
        this._ensureOutlook();
        this.outlookPool.markFailed(this.address, reason);
        this.outlookAddressFinalized = true;
        console.log(`[Mail][outlook] 号池状态更新为 failed: ${this.address}`);
    }
}

module.exports = { MailProvider };
