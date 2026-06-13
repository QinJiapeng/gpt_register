const path = require('path');
const fs = require('fs');
const readline = require('readline/promises');
const { randomInt } = require('node:crypto');
const { initRunLogger } = require('./src/runLogger');
const { SMSProvider } = require('./src/smsProvider');
const { MailProvider } = require('./src/mailProvider');
const { BrowserService } = require('./src/browserService');
const { OAuthService } = require('./src/oauthService');
const { generateRandomName, generateRandomPassword } = require('./src/randomIdentity');
const config = require('./src/config');

const { logFilePath } = initRunLogger(process.cwd());
console.log(`[日志] 本次运行日志文件: ${logFilePath}`);

// command line args
const args = process.argv.slice(2);
const PHASE2_ONLY = args.includes('--phase2');
const PHASE3_ONLY = args.includes('--phase3');
const PHASE8_ONLY = args.includes('--phase8');
const STOP_AFTER_PHASE2 = args.includes('--stop-after-phase2');
const TEST_SMS_COUNTRY_ONLY = args.includes('--test-sms-country');
const COUNTRY_ARG = (args.find(a => a.startsWith('--country=')) || '').split('=')[1] || '';
const TARGET_COUNT = parseInt(args.find(a => /^\d+$/.test(a)) || '1', 10);
const ACCOUNTS_FILE = path.join(process.cwd(), 'accounts.json');
const USERNAME_FILE = path.join(process.cwd(), 'username.json');
const SHIBAI_FILE = path.join(process.cwd(), 'shibai.json');
const TOKEN_OUTPUT_DIR = config.tokenOutputDir || path.join(process.cwd(), 'tokens');
const SMS_POLL_INTERVAL = 5000;
const SMS_MAX_WAIT_MS = 3 * 60 * 1000;
const SMS_MAX_ATTEMPTS = Math.ceil(SMS_MAX_WAIT_MS / SMS_POLL_INTERVAL); // 3 min
const PHASE8_ACCOUNT_DELAY_MS = 60 * 1000;
const MAIL_PROVIDER = String(config.mailProvider || '').toLowerCase();
const TOKEN_AUTH_MAIL_PROVIDERS = new Set(['cloud-mail', 'cloudflare-worker']);
let SELECTED_PHONE_COUNTRY = null;
let SELECTED_SMS_OPERATOR = '';
const SMS_OPERATOR_SELECTION_THRESHOLD = 20;
const BATCH_FAILURES = [];

function isProxyConnectionError(error) {
    const msg = String(error?.message || '');
    return msg.includes('ERR_PROXY_CONNECTION_FAILED') || msg.includes('ECONNREFUSED') || msg.includes('tunnel') || msg.includes('proxy');
}

function readCmdlineByPid(pid) {
    if (!pid || process.platform !== 'linux') return '';
    try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        return raw.replace(/\u0000/g, ' ').trim();
    } catch (e) {
        return '';
    }
}

function getParentPid(pid) {
    if (!pid || process.platform !== 'linux') return 0;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const parts = stat.split(' ');
        return parseInt(parts[3], 10) || 0;
    } catch (e) {
        return 0;
    }
}

function assertNotRunningWithXvfb() {
    if (process.platform !== 'linux') return;

    const parentCmd = readCmdlineByPid(process.ppid);
    const grandParentPid = getParentPid(process.ppid);
    const grandParentCmd = readCmdlineByPid(grandParentPid);
    const xauthority = String(process.env.XAUTHORITY || '').toLowerCase();
    const display = String(process.env.DISPLAY || '').toLowerCase();

    const hit =
        /\bxvfb-run\b/.test(parentCmd) ||
        /\bxvfb-run\b/.test(grandParentCmd) ||
        xauthority.includes('xvfb-run') ||
        display.includes('xvfb');

    if (hit) {
        throw new Error('禁止使用 xvfb 运行项目。请在远程桌面图形会话中直接执行: node index.js');
    }
}

/**
 * 生成随机用户数据
 */
function generateUserData() {
    const fullName = generateRandomName();
    const password = generateRandomPassword();

    const age = 25 + Math.floor(Math.random() * 16);
    const birthYear = new Date().getFullYear() - age;
    const birthMonth = 1 + Math.floor(Math.random() * 12);
    const birthDay = 1 + Math.floor(Math.random() * 28);
    const birthDate = `${birthYear}-${String(birthMonth).padStart(2, '0')}-${String(birthDay).padStart(2, '0')}`;

    return { fullName, password, age, birthDate, birthMonth, birthDay, birthYear };
}

/**
 * 从邮箱中轮询获取验证码
 */
function mailToRawText(mail = {}) {
    const parts = [
        mail.raw,
        mail.text,
        mail.content,
        mail.subject,
        mail.message,
    ].filter(v => typeof v === 'string' && v.trim().length > 0);
    return parts.join('\n\n');
}

function extractMailBody(raw = '') {
    if (!raw || typeof raw !== 'string') return '';

    // cloud-mail 返回的是完整 HTML，不是 MIME 原文，直接用全文
    if (/<html[\s>]|<body[\s>]/i.test(raw)) {
        return raw;
    }

    // 兼容 MIME 原文，优先提取 html part
    const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:--[^\r\n]+--|$)/i);
    if (htmlMatch) {
        return htmlMatch[1];
    }

    // MIME 兜底：只保留尾部正文段
    const parts = raw.split(/\r?\n\r?\n/);
    if (parts.length > 1) {
        return parts.slice(Math.max(1, parts.length - 3)).join('\n');
    }

    return raw;
}

function extractVerificationCodeFromBody(body = '', raw = '') {
    if (!body) return null;

    // 先走强模式：关键字附近、标签/注释包裹的独立 6 位码
    const strongPatterns = [
        /(?:code|验证码|verification(?:\s+code)?|verify|one[-\s]*time\s+code|temporary\s+code)[^\d]{0,120}(\d{6})/i,
        /-->\s*(\d{6})\s*<!--/i,
        />\s*(\d{6})\s*</,
    ];
    for (const pattern of strongPatterns) {
        const match = body.match(pattern);
        if (match) return match[1];
    }

    // 再走弱模式：扫描所有 6 位数字并过滤掉 URL/样式中的噪音
    const candidates = [];
    for (const m of body.matchAll(/\d{6}/g)) {
        const idx = m.index || 0;
        const code = m[0];
        const prev = body[idx - 1] || '';
        const next = body[idx + 6] || '';
        const ctx = body.slice(Math.max(0, idx - 80), Math.min(body.length, idx + 120)).toLowerCase();

        const looksLikeHexColor = prev === '#';
        const looksLikeUrlNoise = ctx.includes('http') || ctx.includes('href=') || ctx.includes('sendgrid');
        const looksLikeStyleNoise = ctx.includes('color:') || ctx.includes('font-') || ctx.includes('css');
        const touchedByWord = /[a-z]/i.test(prev) || /[a-z]/i.test(next);

        if (looksLikeHexColor || looksLikeUrlNoise || looksLikeStyleNoise || touchedByWord) {
            continue;
        }
        candidates.push(code);
    }

    if (candidates.length > 0) return candidates[0];

    // 最后兜底（尽量沿用原逻辑）
    const allSixDigits = body.match(/\b(\d{6})\b/g) || [];
    const filtered = allSixDigits.filter(d => !raw.includes(`t=${d}`) && !raw.includes(`x=${d}`));
    return filtered.length > 0 ? filtered[0] : null;
}

async function pollEmailCode(mailProvider, maxAttempts = 30, interval = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[Mail] 轮询邮箱验证码... (${attempt}/${maxAttempts})`);

        try {
            const mails = await mailProvider.getMails(5, 0);
            if (mails.length > 0) {
                const latest = mails[0];
                const raw = mailToRawText(latest);
                const body = extractMailBody(raw);
                const code = extractVerificationCodeFromBody(body, raw);
                if (code) {
                    console.log(`[Mail] 收到验证码: ${code}`);
                    return code;
                }

                console.log(`[Mail] 邮件已收到但未提取到验证码，正文前200字: ${body.substring(0, 200)}`);
            }
        } catch (error) {
            console.error(`[Mail] 查询出错: ${error.message}`);
        }

        await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(`邮箱验证码超时（等待 ${(maxAttempts * interval) / 1000} 秒）`);
}

/**
 * 保存已注册账号到 accounts.json
 */
function extractVerificationCodeFromMail(mail = {}) {
    const raw = mailToRawText(mail);
    if (!raw) return null;
    const body = extractMailBody(raw);
    return extractVerificationCodeFromBody(body, raw);
}

async function pollEmailCodeByAddress(mailProvider, email, maxAttempts = 30, interval = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[Mail][Phase8] polling ${email} code... (${attempt}/${maxAttempts})`);
        try {
            const mails = await mailProvider.getMailsByAddress(email, 5, 0);
            if (Array.isArray(mails) && mails.length > 0) {
                const code = extractVerificationCodeFromMail(mails[0] || {});
                if (code) {
                    console.log(`[Mail][Phase8] latest code for ${email}: ${code}`);
                    return code;
                }
            }
        } catch (error) {
            console.error(`[Mail][Phase8] query error for ${email}: ${error.message}`);
        }
        await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`${email} email code timeout`);
}

function readJsonArray(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') return [parsed];
        return [];
    } catch (e) {
        return [];
    }
}

function appendToJsonArrayFile(filePath, item) {
    const list = readJsonArray(filePath);
    list.push(item);
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    return list.length;
}

function appendFailedToShibai(entry) {
    const failedEntry = entry && typeof entry === 'object' ? { ...entry } : { raw: entry };
    const total = appendToJsonArrayFile(SHIBAI_FILE, failedEntry);
    console.log(`[Phase8] appended failed record to shibai.json, total=${total}`);
}

function calcAgeFromBirthDate(birthDate) {
    const year = parseInt(String(birthDate || '').slice(0, 4), 10);
    if (!Number.isFinite(year)) return 30;
    return Math.max(18, new Date().getFullYear() - year);
}

function normalizeNameTokens(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[()]/g, ' ')
        .replace(/\s+/g, ' ');
}

function getConfiguredPhoneCountries() {
    return Array.isArray(config.phoneCountries) ? config.phoneCountries : [];
}

function getConfiguredMailDomains() {
    return Array.isArray(config.mailDomains)
        ? config.mailDomains.map(item => String(item || '').trim().replace(/^@/, '')).filter(Boolean)
        : [];
}

function pickMailDomain() {
    const domains = getConfiguredMailDomains();
    if (domains.length === 0) return '';
    if (domains.length === 1) return domains[0];
    return domains[randomInt(domains.length)];
}

function hasNumericValue(value) {
    return value !== undefined
        && value !== null
        && String(value).trim() !== ''
        && Number.isFinite(Number(value));
}

function findConfiguredCountryByCode(isoCode) {
    const code = String(isoCode || '').trim().toUpperCase();
    if (!code) return null;
    return getConfiguredPhoneCountries().find(item => item.isoCode === code) || null;
}

function getDefaultPhoneCountry() {
    const byArg = findConfiguredCountryByCode(COUNTRY_ARG);
    if (byArg) return byArg;

    const byConfigCode = findConfiguredCountryByCode(config.phoneCountryCode);
    if (byConfigCode) return byConfigCode;

    const byHeroSmsCountry = getConfiguredPhoneCountries().find(item => Number(item.heroSmsCountry) === Number(config.heroSmsCountry));
    if (byHeroSmsCountry) return byHeroSmsCountry;

    return getConfiguredPhoneCountries()[0] || {
        isoCode: 'GB',
        dialCode: '44',
        name: '英国',
        aliases: [],
        heroSmsCountry: Number(config.heroSmsCountry) || 16,
    };
}

function resolvePhoneCountryForPhone(phone, fallback = null) {
    const normalized = String(phone || '').trim();
    const countries = [...getConfiguredPhoneCountries()]
        .sort((a, b) => String(b.dialCode || '').length - String(a.dialCode || '').length);
    for (const country of countries) {
        if (normalized.startsWith(`+${country.dialCode}`)) {
            return country;
        }
    }

    if (fallback) {
        return {
            isoCode: fallback.isoCode || '',
            dialCode: String(fallback.dialCode || fallback.phoneCountryDialCode || '').replace(/^\+/, ''),
            name: fallback.name || fallback.phoneCountryName || '',
            aliases: Array.isArray(fallback.aliases) ? fallback.aliases : [],
            heroSmsCountry: fallback.heroSmsCountry || null,
        };
    }

    return getDefaultPhoneCountry();
}

function buildCountryNameSet(country = {}) {
    return new Set([
        country.name,
        ...(Array.isArray(country.aliases) ? country.aliases : []),
    ].map(v => normalizeNameTokens(v)).filter(Boolean));
}

function enrichConfiguredCountryWithApiMeta(country, apiCountry = {}) {
    return {
        ...country,
        heroSmsCountry: hasNumericValue(country.heroSmsCountry)
            ? Number(country.heroSmsCountry)
            : Number(apiCountry.heroSmsCountry),
        apiName: apiCountry.apiName || '',
        apiIsoCode: apiCountry.isoCode || '',
        apiDialCode: apiCountry.dialCode || '',
    };
}

function buildCountryFromApiOnly(apiCountry = {}) {
    const isoCode = String(apiCountry.isoCode || '').trim().toUpperCase();
    const dialCode = String(apiCountry.dialCode || '').replace(/^\+/, '').trim();
    const name = String(apiCountry.apiName || '').trim();
    if (!isoCode || !dialCode || !name) return null;
    return {
        isoCode,
        dialCode,
        name,
        aliases: [],
        heroSmsCountry: Number(apiCountry.heroSmsCountry),
        apiName: apiCountry.apiName || '',
        apiIsoCode: apiCountry.isoCode || '',
        apiDialCode: apiCountry.dialCode || '',
    };
}

function matchApiCountryToConfiguredCountry(apiCountry, configuredCountries) {
    const apiName = normalizeNameTokens(apiCountry.apiName);
    const apiIsoCode = String(apiCountry.isoCode || '').trim().toUpperCase();
    const apiDialCode = String(apiCountry.dialCode || '').replace(/^\+/, '').trim();

    for (const configured of configuredCountries) {
        if (configured.isoCode && apiIsoCode && configured.isoCode === apiIsoCode) return configured;
    }

    for (const configured of configuredCountries) {
        if (configured.dialCode && apiDialCode && configured.dialCode === apiDialCode) return configured;
    }

    for (const configured of configuredCountries) {
        const names = buildCountryNameSet(configured);
        if (apiName && names.has(apiName)) return configured;
    }

    for (const configured of configuredCountries) {
        const names = [...buildCountryNameSet(configured)];
        if (apiName && names.some(name => apiName.includes(name) || name.includes(apiName))) {
            return configured;
        }
    }

    return null;
}

function printCountryPriceTable(rows, title = '[SMS] HeroSMS 最便宜国家 Top 列表') {
    console.log(`\n${title}`);
    console.log('序号 | ISO | 国家 | 区号 | HeroSMS | 价格($) | 库存');
    console.log('---- | --- | ---- | ---- | ------- | ------- | ----');
    rows.forEach((row, index) => {
        const price = Number.isFinite(Number(row.price)) ? Number(row.price).toFixed(3) : '-';
        const stock = Number.isFinite(Number(row.count)) ? String(row.count) : '-';
        console.log(`${String(index + 1).padEnd(4)} | ${row.isoCode.padEnd(3)} | ${row.name.padEnd(10)} | +${String(row.dialCode).padEnd(4)} | ${String(row.heroSmsCountry).padEnd(7)} | ${price.padEnd(7)} | ${stock}`);
    });
}

function getHeroSmsMaxPrice() {
    const maxPrice = Number(config.heroSmsMaxPrice);
    return Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null;
}

function applyHeroSmsMaxPrice(rows) {
    const maxPrice = getHeroSmsMaxPrice();
    if (maxPrice === null) return rows;

    const filtered = rows.filter((row) => {
        const price = Number(row.price);
        return Number.isFinite(price) && price <= maxPrice;
    });
    const removed = rows.length - filtered.length;
    if (removed > 0) {
        console.log(`[SMS] 已过滤高于 $${maxPrice.toFixed(3)} 的报价 ${removed} 条`);
    }
    return filtered;
}

function printOperatorOptionTable(rows, country) {
    console.log(`\n[SMS] ${country.name} 可选运营商 / 报价列表`);
    console.log('序号 | 运营商 | 价格($) | 库存 | 说明');
    console.log('---- | ------ | ------- | ---- | ----');
    rows.forEach((row, index) => {
        const price = Number.isFinite(Number(row.price)) ? Number(row.price).toFixed(4) : '-';
        const stock = Number.isFinite(Number(row.count)) ? String(row.count) : '-';
        const note = row.note || '';
        console.log(`${String(index + 1).padEnd(4)} | ${String(row.label).padEnd(6)} | ${price.padEnd(7)} | ${stock.padEnd(4)} | ${note}`);
    });
}

async function promptUserToChooseCountry(rows, defaultCountry) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(`[SMS] 当前不是交互终端，自动使用默认国家: ${defaultCountry.name} (+${defaultCountry.dialCode})`);
        return defaultCountry;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        while (true) {
            const answer = (await rl.question(`请选择国家（输入序号 / ISO / HeroSMS 国家ID，直接回车默认 ${defaultCountry.isoCode}）: `)).trim();
            if (!answer) return defaultCountry;

            const byIndex = rows[Number.parseInt(answer, 10) - 1];
            if (byIndex) return byIndex;

            const byCode = rows.find(item => item.isoCode === answer.toUpperCase());
            if (byCode) return byCode;

            const byHeroSmsCountry = rows.find(item => String(item.heroSmsCountry) === answer);
            if (byHeroSmsCountry) return byHeroSmsCountry;

            console.log('[SMS] 选择无效，请重新输入。');
        }
    } finally {
        rl.close();
    }
}

async function promptUserToChooseOperator(rows, defaultOption, country) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(`[SMS] 当前不是交互终端，自动使用默认运营商: ${defaultOption.label} (${country.name})`);
        return defaultOption;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        while (true) {
            const answer = (await rl.question(`请选择 ${country.name} 的运营商（输入序号 / 名称，直接回车默认 ${defaultOption.label}）: `)).trim();
            if (!answer) return defaultOption;

            const byIndex = rows[Number.parseInt(answer, 10) - 1];
            if (byIndex) return byIndex;

            const lowered = answer.toLowerCase();
            const byName = rows.find(item => item.operator.toLowerCase() === lowered || item.label.toLowerCase() === lowered);
            if (byName) return byName;

            console.log('[SMS] 运营商选择无效，请重新输入。');
        }
    } finally {
        rl.close();
    }
}

async function resolveRunSmsOperator(phoneCountry, options = {}) {
    const { debug = false } = options;
    const smsProvider = new SMSProvider(config.heroSmsApiKey);
    const countryId = Number(phoneCountry?.heroSmsCountry);
    if (!Number.isFinite(countryId)) {
        return { operator: '', label: '任何运营商', price: phoneCountry?.price ?? null, count: phoneCountry?.count ?? null, note: '国家未绑定 HeroSMS ID，跳过运营商选择' };
    }

    try {
        const aggregateCount = Number(phoneCountry?.count);
        if (Number.isFinite(aggregateCount) && aggregateCount >= SMS_OPERATOR_SELECTION_THRESHOLD) {
            console.log(`[SMS] ${phoneCountry.name} 当前聚合库存 ${aggregateCount}，不触发二次运营商选择`);
            return {
                operator: '',
                label: '任何运营商',
                price: phoneCountry?.price ?? null,
                count: phoneCountry?.count ?? null,
                note: `聚合库存 >= ${SMS_OPERATOR_SELECTION_THRESHOLD}`,
            };
        }

        const operatorOptions = applyHeroSmsMaxPrice(
            await smsProvider.getOperatorQuoteOptions(config.heroSmsService, countryId)
        );
        if (debug) {
            console.log(`[SMS][Debug] operatorOptions(${countryId})=${JSON.stringify(operatorOptions.slice(0, 20))}`);
        }

        const aggregateOption = {
            operator: '',
            label: '任何运营商',
            price: phoneCountry?.price ?? null,
            count: phoneCountry?.count ?? null,
            note: '国家聚合库存',
        };

        if (operatorOptions.length === 0) {
            console.log(`[SMS] ${phoneCountry.name} 未返回运营商列表，使用「任何运营商」`);
            return aggregateOption;
        }

        const rows = [
            aggregateOption,
            ...operatorOptions.map((item) => ({
                ...item,
                label: item.operator,
                note: item.error ? `查询失败: ${item.error}` : '运营商聚合库存',
            })),
        ];

        console.log(`[SMS] ${phoneCountry.name} 聚合库存 ${Number.isFinite(aggregateCount) ? aggregateCount : '-'}，低于 ${SMS_OPERATOR_SELECTION_THRESHOLD}，进入运营商二次选择`);
        printOperatorOptionTable(rows, phoneCountry);

        const betterOption = operatorOptions.find(item =>
            Number.isFinite(Number(item.count)) && Number(item.count) > Number(phoneCountry?.count || 0)
        );
        const defaultOption = betterOption
            ? rows.find(item => item.operator === betterOption.operator) || aggregateOption
            : aggregateOption;

        const selected = await promptUserToChooseOperator(rows, defaultOption, phoneCountry);
        console.log(`[SMS] 已选择运营商: ${selected.label} (${phoneCountry.name})`);
        return selected;
    } catch (error) {
        console.warn(`[SMS] 获取 ${phoneCountry.name} 运营商列表失败，使用「任何运营商」: ${error.message}`);
        return {
            operator: '',
            label: '任何运营商',
            price: phoneCountry?.price ?? null,
            count: phoneCountry?.count ?? null,
            note: '运营商接口失败，回退聚合库存',
        };
    }
}

async function resolveRunPhoneCountry(options = {}) {
    const { debug = false } = options;
    const configuredCountries = getConfiguredPhoneCountries();
    const defaultCountry = getDefaultPhoneCountry();
    const smsProvider = new SMSProvider(config.heroSmsApiKey);
    const forcedCountry = findConfiguredCountryByCode(COUNTRY_ARG);

    let countriesForPricing = configuredCountries
        .filter(item => hasNumericValue(item.heroSmsCountry));

    if (countriesForPricing.length < Math.min(10, configuredCountries.length)) {
        try {
            const apiCountries = await smsProvider.getCountries();
            if (debug) {
                console.log(`[SMS][Debug] getCountries parsed count=${apiCountries.length}`);
                console.log(`[SMS][Debug] getCountries sample=${JSON.stringify(apiCountries.slice(0, 10))}`);
            }
            if (apiCountries.length > 0) {
                const unique = new Map();
                for (const apiCountry of apiCountries) {
                    const configured = matchApiCountryToConfiguredCountry(apiCountry, configuredCountries);
                    if (!configured) continue;
                    unique.set(configured.isoCode, enrichConfiguredCountryWithApiMeta(configured, apiCountry));
                }
                countriesForPricing = [...unique.values()];
                if (debug) {
                    console.log(`[SMS][Debug] countriesForPricing mapped from getCountries=${countriesForPricing.length}`);
                    console.log(`[SMS][Debug] countriesForPricing sample=${JSON.stringify(countriesForPricing.slice(0, 10))}`);
                }
            }
        } catch (error) {
            console.warn(`[SMS] 获取国家列表失败，回退本地配置: ${error.message}`);
        }
    }

    if (countriesForPricing.length === 0) {
        console.warn('[SMS] 没有可用于 HeroSMS 的国家列表，使用默认国家');
        return {
            ...defaultCountry,
            heroSmsCountry: Number(defaultCountry.heroSmsCountry) || Number(config.heroSmsCountry) || 16,
        };
    }

    try {
        const topCountries = await smsProvider.getTopCountriesByService(config.heroSmsService);
        if (debug) {
            console.log(`[SMS][Debug] topCountries count=${topCountries.length}`);
            console.log(`[SMS][Debug] topCountries sample=${JSON.stringify(topCountries.slice(0, 15))}`);
        }
        if (topCountries.length > 0) {
            const byId = new Map(countriesForPricing.map(item => [Number(item.heroSmsCountry), item]));
            const rankedCountries = applyHeroSmsMaxPrice(topCountries
                .map((item) => {
                    let base = byId.get(Number(item.heroSmsCountry));
                    if (!base) {
                        const matchedConfigured = matchApiCountryToConfiguredCountry(item, configuredCountries);
                        if (matchedConfigured) {
                            base = enrichConfiguredCountryWithApiMeta(matchedConfigured, item);
                        } else {
                            base = buildCountryFromApiOnly(item);
                        }
                    }
                    if (!base) return null;
                    return {
                        ...base,
                        price: item.price,
                        count: item.count,
                    };
                })
                .filter(Boolean));

            console.log(`[SMS] Top Countries 返回 ${topCountries.length} 条，成功映射 ${rankedCountries.length} 条`);

            if (rankedCountries.length > 0) {
                const topN = Math.max(1, Number(config.heroSmsCountryTopN) || 5);
                const topRows = rankedCountries.slice(0, topN);
                printCountryPriceTable(topRows);

                if (forcedCountry) {
                    const match = rankedCountries.find(item => item.isoCode === forcedCountry.isoCode);
                    if (match) {
                        console.log(`[SMS] 已通过 --country 指定国家: ${match.name} (+${match.dialCode})，价格 $${match.price.toFixed(3)}`);
                        return match;
                    }
                    console.warn(`[SMS] --country=${forcedCountry.isoCode} 不在当前 Top Countries 列表中，改用默认选择`);
                }

                const defaultPricedCountry = rankedCountries.find(item => item.isoCode === defaultCountry.isoCode) || topRows[0];
                if (config.heroSmsPromptCountrySelection === false) {
                    console.log(`[SMS] 已关闭交互选择，自动使用: ${defaultPricedCountry.name} (+${defaultPricedCountry.dialCode})`);
                    return defaultPricedCountry;
                }

                const selected = await promptUserToChooseCountry(topRows, defaultPricedCountry);
                console.log(`[SMS] 已选择国家: ${selected.name} (+${selected.dialCode})，HeroSMS 国家ID=${selected.heroSmsCountry}，价格 $${selected.price.toFixed(3)}`);
                return selected;
            }

            const debugIds = topCountries.slice(0, 10).map(item => ({
                heroSmsCountry: item.heroSmsCountry,
                apiName: item.apiName || '',
                isoCode: item.isoCode || '',
                dialCode: item.dialCode || '',
                price: item.price,
            }));
            console.warn(`[SMS] Top Countries 已返回数据，但未能映射到可选国家。样例=${JSON.stringify(debugIds)}`);
        }
    } catch (error) {
        console.warn(`[SMS] Top Countries 接口不可用，回退到价格矩阵解析: ${error.message}`);
    }

    try {
        const pricedCountries = applyHeroSmsMaxPrice(
            await smsProvider.listCountryPrices(config.heroSmsService, countriesForPricing)
        );
        if (debug) {
            console.log(`[SMS][Debug] pricedCountries count=${pricedCountries.length}`);
            console.log(`[SMS][Debug] pricedCountries sample=${JSON.stringify(pricedCountries.slice(0, 10))}`);
        }
        if (pricedCountries.length === 0) {
            throw new Error('价格列表为空');
        }

        const topN = Math.max(1, Number(config.heroSmsCountryTopN) || 5);
        const topRows = pricedCountries.slice(0, topN);
        printCountryPriceTable(topRows);

        if (forcedCountry) {
            const match = pricedCountries.find(item => item.isoCode === forcedCountry.isoCode);
            if (match) {
                console.log(`[SMS] 已通过 --country 指定国家: ${match.name} (+${match.dialCode})，价格 $${match.price.toFixed(3)}`);
                return match;
            }
            console.warn(`[SMS] --country=${forcedCountry.isoCode} 不在当前价格列表中，改用默认选择`);
        }

        const defaultPricedCountry = pricedCountries.find(item => item.isoCode === defaultCountry.isoCode) || topRows[0];
        if (config.heroSmsPromptCountrySelection === false) {
            console.log(`[SMS] 已关闭交互选择，自动使用: ${defaultPricedCountry.name} (+${defaultPricedCountry.dialCode})`);
            return defaultPricedCountry;
        }

        const selected = await promptUserToChooseCountry(topRows, defaultPricedCountry);
        console.log(`[SMS] 已选择国家: ${selected.name} (+${selected.dialCode})，HeroSMS 国家ID=${selected.heroSmsCountry}，价格 $${selected.price.toFixed(3)}`);
        return selected;
    } catch (error) {
        const maxPrice = getHeroSmsMaxPrice();
        if (maxPrice !== null) {
            throw new Error(`获取 HeroSMS 价格失败，无法保证最高价格 $${maxPrice.toFixed(3)}: ${error.message}`);
        }
        console.warn(`[SMS] 获取 HeroSMS 价格失败，回退到默认国家: ${error.message}`);
        return {
            ...defaultCountry,
            heroSmsCountry: Number(defaultCountry.heroSmsCountry) || Number(config.heroSmsCountry) || 16,
        };
    }
}

async function runSmsCountryDebug() {
    console.log('[测试] 仅测试 HeroSMS 国家/价格解析');
    console.log(`[测试] service=${config.heroSmsService}, 默认国家=${config.phoneCountryCode}, 配置国家数=${getConfiguredPhoneCountries().length}`);
    const selected = await resolveRunPhoneCountry({ debug: true });
    console.log(`[测试] 最终选择结果: ${selected.name} (+${selected.dialCode}), HeroSMS 国家ID=${selected.heroSmsCountry}`);
    const selectedOperator = await resolveRunSmsOperator(selected, { debug: true });
    console.log(`[测试] 最终运营商结果: ${selectedOperator.label}`);
}

function getUsernameRecords() {
    return readJsonArray(USERNAME_FILE);
}

function parseTimeValue(value) {
    const ts = Date.parse(String(value || ''));
    return Number.isFinite(ts) ? ts : 0;
}

function sortRecordsByCreatedAtDesc(records = []) {
    return [...records].sort((a, b) => parseTimeValue(b?.createdAt) - parseTimeValue(a?.createdAt));
}

function formatTimeForDisplay(value) {
    if (!value) return '-';
    const ts = Date.parse(String(value));
    if (!Number.isFinite(ts)) return String(value);
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function truncateDisplay(value, max = 24) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
}

function buildRunContextSummary(runContext = {}, error = null) {
    return {
        time: new Date().toISOString(),
        stage: runContext.stage || '-',
        phone: runContext.phone || '-',
        email: runContext.email || '-',
        name: runContext.name || '-',
        country: runContext.phoneCountryCode || '-',
        operator: runContext.smsOperator || '-',
        mailDomain: runContext.mailDomain || '-',
        error: String(error?.message || error || 'unknown'),
    };
}

function printBatchFailureSummary(items = []) {
    if (!Array.isArray(items) || items.length === 0) return;
    console.log('\n[汇总] 本轮运行出现异常的账号列表');
    console.log('序号 | 时间 | 阶段 | 手机号 | 邮箱 | 国家 | 域名 | 错误');
    console.log('---- | ---- | ---- | ------ | ---- | ---- | ---- | ----');
    items.forEach((item, index) => {
        console.log(
            `${String(index + 1).padEnd(4)} | ${formatTimeForDisplay(item.time)} | ${String(item.stage || '-').padEnd(18)} | ${String(item.phone || '-').padEnd(12)} | ${truncateDisplay(item.email || '-', 24).padEnd(24)} | ${String(item.country || '-').padEnd(4)} | ${truncateDisplay(item.mailDomain || '-', 14).padEnd(14)} | ${truncateDisplay(item.error || '-', 42)}`
        );
    });
}

function getLatestUsernameRecord() {
    const records = getUsernameRecords();
    if (records.length === 0) return null;
    return records[records.length - 1] || null;
}

function saveAccount(phone, password, name, birthDate, phoneCountry = null, smsOperator = '') {
    let accounts = [];
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) {}
    }
    const resolvedCountry = phoneCountry || resolvePhoneCountryForPhone(phone, SELECTED_PHONE_COUNTRY);
    accounts.push({
        phone, password, name, birthDate,
        phoneCountryCode: resolvedCountry?.isoCode || '',
        phoneCountryDialCode: resolvedCountry?.dialCode || '',
        phoneCountryName: resolvedCountry?.name || '',
        heroSmsCountry: resolvedCountry?.heroSmsCountry || null,
        smsOperator: smsOperator || SELECTED_SMS_OPERATOR || '',
        createdAt: new Date().toISOString(),
        status: 'registered',
    });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    console.log(`[账号] 已保存到 accounts.json (共 ${accounts.length} 个)`);
}

/**
 * 加载一个未完成 OAuth 的账号
 */
function loadAccount() {
    if (!fs.existsSync(ACCOUNTS_FILE)) return null;
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const available = accounts.find(a => a.status === 'registered' && a.password);
    return available || null;
}

function getPhase2CandidateAccounts() {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    try {
        const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        return sortRecordsByCreatedAtDesc(accounts.filter((item) => {
            const status = String(item?.status || '').trim();
            return !!item?.phone
                && !!item?.password
                && ['registered', 'oauth_phase2_failed'].includes(status || 'registered');
        }));
    } catch (e) {
        return [];
    }
}

function getPhase3CandidateEntries() {
    return sortRecordsByCreatedAtDesc(
        getUsernameRecords().filter((item) => !!item?.email && !!item?.password)
    );
}

function printPhase2Candidates(records = []) {
    console.log('\n[Phase2] 可恢复账号列表（按时间倒序）');
    console.log('序号 | 时间 | 手机号 | 状态 | 国家 | 姓名');
    console.log('---- | ---- | ------ | ---- | ---- | ----');
    records.forEach((item, index) => {
        console.log(
            `${String(index + 1).padEnd(4)} | ${formatTimeForDisplay(item.createdAt)} | ${String(item.phone || '-').padEnd(12)} | ${String(item.status || 'registered').padEnd(16)} | ${String(item.phoneCountryCode || '-').padEnd(4)} | ${truncateDisplay(item.name || '-', 20)}`
        );
    });
}

function printPhase3Candidates(records = []) {
    console.log('\n[Phase3] 可补 token 列表（按时间倒序）');
    console.log('序号 | 时间 | 邮箱 | 手机号 | 状态');
    console.log('---- | ---- | ---- | ------ | ----');
    records.forEach((item, index) => {
        console.log(
            `${String(index + 1).padEnd(4)} | ${formatTimeForDisplay(item.createdAt)} | ${truncateDisplay(item.email || '-', 28).padEnd(28)} | ${String(item.phone || '-').padEnd(12)} | ${String(item.status || '-').padEnd(16)}`
        );
    });
}

async function promptSelectRecord(records, promptText, finder) {
    if (!Array.isArray(records) || records.length === 0) return null;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log('[选择] 当前不是交互终端，自动使用列表第一条');
        return records[0];
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        while (true) {
            const answer = (await rl.question(promptText)).trim();
            if (!answer) return records[0];

            const byIndex = records[Number.parseInt(answer, 10) - 1];
            if (byIndex) return byIndex;

            const byCustom = finder ? finder(answer) : null;
            if (byCustom) return byCustom;

            console.log('[选择] 输入无效，请重新输入。');
        }
    } finally {
        rl.close();
    }
}

async function choosePhase2Account() {
    const records = getPhase2CandidateAccounts();
    if (records.length === 0) return null;
    printPhase2Candidates(records);
    return await promptSelectRecord(
        records,
        '请选择要继续绑定邮箱的账号（输入序号或手机号，直接回车默认第一条）: ',
        (answer) => records.find(item => String(item.phone || '').trim() === answer)
    );
}

async function choosePhase3Entry() {
    const records = getPhase3CandidateEntries();
    if (records.length === 0) return null;
    printPhase3Candidates(records);
    return await promptSelectRecord(
        records,
        '请选择要补 token 的记录（输入序号 / 邮箱 / 手机号，直接回车默认第一条）: ',
        (answer) => records.find(item =>
            String(item.email || '').trim().toLowerCase() === answer.toLowerCase()
            || String(item.phone || '').trim() === answer
        )
    );
}

function findAccountByPhone(phone) {
    if (!phone || !fs.existsSync(ACCOUNTS_FILE)) return null;
    try {
        const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        return accounts.find(a => a.phone === phone) || null;
    } catch (e) {
        return null;
    }
}

/**
 * 更新账号状态
 */
function updateAccountStatus(phone, status) {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    const account = accounts.find(a => a.phone === phone);
    if (account) {
        account.status = status;
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    }
}

function updateUsernameStatus(email, status) {
    if (!email || !fs.existsSync(USERNAME_FILE)) return;
    try {
        const records = JSON.parse(fs.readFileSync(USERNAME_FILE, 'utf8'));
        const list = Array.isArray(records) ? records : [records];
        let changed = false;
        for (let index = list.length - 1; index >= 0; index -= 1) {
            if (String(list[index]?.email || '').trim().toLowerCase() === String(email).trim().toLowerCase()) {
                list[index].status = status;
                changed = true;
                break;
            }
        }
        if (changed) {
            fs.writeFileSync(USERNAME_FILE, JSON.stringify(list, null, 2));
        }
    } catch (e) {}
}

async function finalizeSmsActivation(smsProvider) {
    if (!smsProvider?.activationId) return;
    try {
        await smsProvider.complete();
    } catch (error) {
        console.warn(`[SMS] 主流程已成功，但标记激活完成失败: ${error.message}`);
    }
}

function saveUsernameFile({ email, phone, password, name, birthDate, status, phoneCountry, smsOperator }) {
    const account = findAccountByPhone(phone);
    const resolvedCountry = phoneCountry
        || (account ? resolvePhoneCountryForPhone(account.phone, account) : null)
        || resolvePhoneCountryForPhone(phone, SELECTED_PHONE_COUNTRY);
    const outData = {
        email: email || '',
        phone: phone || '',
        password: password || '',
        name: name || '',
        birthDate: birthDate || '',
        phoneCountryCode: resolvedCountry?.isoCode || account?.phoneCountryCode || '',
        phoneCountryDialCode: resolvedCountry?.dialCode || account?.phoneCountryDialCode || '',
        phoneCountryName: resolvedCountry?.name || account?.phoneCountryName || '',
        heroSmsCountry: resolvedCountry?.heroSmsCountry || account?.heroSmsCountry || null,
        smsOperator: smsOperator || account?.smsOperator || SELECTED_SMS_OPERATOR || '',
        createdAt: account?.createdAt || new Date().toISOString(),
        status: status || account?.status || 'registered',
    };

    let usernameList = [];
    if (fs.existsSync(USERNAME_FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(USERNAME_FILE, 'utf8'));
            if (Array.isArray(parsed)) {
                usernameList = parsed;
            } else if (parsed && typeof parsed === 'object') {
                usernameList = [parsed];
            }
        } catch (e) {
            usernameList = [];
        }
    }

    usernameList.push(outData);
    fs.writeFileSync(USERNAME_FILE, JSON.stringify(usernameList, null, 2));
    console.log(`[账号] 已追加保存账户信息: ${USERNAME_FILE} (共 ${usernameList.length} 条)`);
}

function isSmsNoNumbersError(error) {
    return error?.code === 'SMS_NO_NUMBERS' || String(error?.message || '').includes('当前无可用号码');
}

function describeSmsNumberCandidate(candidate) {
    const operatorLabel = candidate.operator ? `运营商 ${candidate.operator}` : '任何运营商';
    const priceLabel = Number.isFinite(Number(candidate.price))
        ? `, 价格 $${Number(candidate.price).toFixed(4)}`
        : '';
    return `${operatorLabel}${priceLabel}`;
}

function sortSmsQuoteOptions(options = []) {
    return [...options].sort((a, b) => {
        const priceA = Number(a.price);
        const priceB = Number(b.price);
        if (priceA !== priceB) return priceA - priceB;
        return (Number(b.count) || 0) - (Number(a.count) || 0);
    });
}

async function getNumberWithPriceFallback(smsProvider, phoneCountry) {
    const service = config.heroSmsService;
    const countryId = Number(phoneCountry?.heroSmsCountry) || config.heroSmsCountry;
    const attemptedOperators = new Set();
    let lastNoNumbersError = null;
    const initialOperator = String(SELECTED_SMS_OPERATOR || '').trim();
    let failedPrice = !initialOperator && Number.isFinite(Number(phoneCountry?.price))
        ? Number(phoneCountry.price)
        : null;

    const tryCandidate = async (candidate) => {
        const operator = String(candidate.operator || '').trim();
        if (attemptedOperators.has(operator)) return false;
        attemptedOperators.add(operator);

        console.log(`[SMS] 尝试获取号码: ${describeSmsNumberCandidate(candidate)}`);
        try {
            await smsProvider.getNumber(service, countryId, 1, operator);
            SELECTED_SMS_OPERATOR = operator;
            return true;
        } catch (error) {
            if (!isSmsNoNumbersError(error)) throw error;

            lastNoNumbersError = error;
            const candidatePrice = Number(candidate.price);
            if (Number.isFinite(candidatePrice)) {
                failedPrice = candidatePrice;
            }
            console.warn(`[SMS] ${describeSmsNumberCandidate(candidate)} 无可用号码，切换到下一个不超过最高价的报价`);
            return false;
        }
    };

    const initialCandidate = {
        operator: initialOperator,
        price: initialOperator ? null : phoneCountry?.price,
    };
    if (await tryCandidate(initialCandidate)) return true;

    const quoteOptions = sortSmsQuoteOptions(applyHeroSmsMaxPrice(
        await smsProvider.getOperatorQuoteOptions(service, countryId)
    ).filter((item) => {
        if (!item.operator || item.error) return false;
        const count = Number(item.count);
        return !Number.isFinite(count) || count > 0;
    }));

    if (initialOperator && failedPrice === null) {
        const failedQuote = quoteOptions.find(item => item.operator === initialOperator);
        const quotedPrice = Number(failedQuote?.price);
        if (Number.isFinite(quotedPrice)) {
            failedPrice = quotedPrice;
        }
    }

    const fallbackOptions = quoteOptions.filter((item) => {
        const operator = String(item.operator || '').trim();
        if (!operator || attemptedOperators.has(operator)) return false;

        const price = Number(item.price);
        if (!Number.isFinite(price)) return false;

        // 默认“任何运营商”拿到的是当前国家最低价；失败后按就近原则尝试更高价位。
        if (failedPrice !== null && price <= failedPrice) return false;

        return true;
    });

    if (fallbackOptions.length > 0) {
        console.log(`[SMS] 可切换报价 ${fallbackOptions.length} 条，将按价格从低到高尝试`);
    }

    for (const option of fallbackOptions) {
        const optionPrice = Number(option.price);
        if (failedPrice !== null && Number.isFinite(optionPrice) && optionPrice <= failedPrice) {
            continue;
        }
        if (await tryCandidate(option)) return true;
    }

    throw lastNoNumbersError || new Error('当前最高价格范围内没有可用号码');
}

/**
 * 第一阶段：用手机号注册 ChatGPT
 */
async function phase1(smsProvider, browserService, userData, phoneCountry) {
    console.log('\n=========================================');
    console.log('[阶段1] 开始 ChatGPT 手机号注册流程');
    console.log('=========================================');

    // 1. 先导航到注册页面（不花钱，失败了可以直接重试）
    await browserService.navigateToSignup();

    // 2. 浏览器就绪后，才获取手机号（花钱操作尽量靠后）
    await getNumberWithPriceFallback(smsProvider, phoneCountry);
    await smsProvider.markReady();

    let numberUsed = false;

    try {
        // 3. 选择国家并输入手机号
        await browserService.selectCountry(phoneCountry.dialCode, phoneCountry.name, phoneCountry.isoCode);
        const localNumber = browserService.getLocalPhoneNumber(smsProvider.getPhone(), phoneCountry);
        await browserService.enterPhone(localNumber);
        numberUsed = true;

        // 4. 完成注册资料（密码、验证码、姓名、生日等）
        // 当页面需要 SMS 验证码时，通过回调获取
        const profileCompleted = await browserService.completeProfile(userData, async () => {
            console.log('[阶段1] 页面需要 SMS 验证码，开始轮询...');
            const code = await smsProvider.pollForCode({
                interval: SMS_POLL_INTERVAL,
                maxAttempts: SMS_MAX_ATTEMPTS,
            });
            return code;
        });

        if (!profileCompleted) {
            throw new Error('阶段1失败：注册资料填写未完成');
        }

        // 6. 保存账号信息；SMS 激活延后到整条链路成功后再完成
        saveAccount(smsProvider.getPhone(), userData.password, userData.fullName, userData.birthDate, phoneCountry, SELECTED_SMS_OPERATOR);

        console.log('[阶段1] ChatGPT 注册流程完成！');
        return true;

    } catch (error) {
        const isSmsActivationClosed = error?.code === 'SMS_ACTIVATION_CANCELLED' || error?.code === 'SMS_CODE_TIMEOUT_CANCELLED';
        if (!numberUsed) {
            console.error('[阶段1] 流程失败，取消号码退款...');
            await smsProvider.cancel();
        } else if (isSmsActivationClosed) {
            console.error('[阶段1] 本轮短信激活已结束，不再调用 complete，直接进入下一轮');
        } else if (error?.shouldCancelActivation) {
            console.error('[阶段1] 注册失败，取消号码退款...');
            await smsProvider.cancel();
        } else {
            await smsProvider.complete().catch(() => {});
        }
        throw error;
    }
}

/**
 * 第 1.5 阶段：首次登录 chatgpt.com 完成 about-you
 */
async function phase1_5(smsProvider, browserService, userData, phoneCountry) {
    console.log('\n=========================================');
    console.log('[阶段1.5] 首次登录 chatgpt.com 完成个人资料');
    console.log('=========================================');

    await browserService.loginAndCompleteProfile({
        phone: smsProvider.getPhone(),
        password: userData.password,
        fullName: userData.fullName,
        birthDate: userData.birthDate,
        phoneCountry,
    });

    console.log('[阶段1.5] 完成！');
}

/**
 * 第二阶段：Codex OAuth（手机号登录并绑定临时邮箱）
 */
async function phase2(smsProvider, mailProvider, browserService, oauthService, userData, runContext = null) {
    console.log('\n=========================================');
    console.log('[阶段2] 开始 Codex OAuth（绑定临时邮箱）');
    console.log('=========================================');

    // 1. 创建临时邮箱
    await mailProvider.createAddress();
    console.log(`[阶段2] 邮箱: ${mailProvider.getEmail()}`);
    if (runContext) {
        runContext.email = mailProvider.getEmail();
        runContext.stage = 'phase2_bind_email';
    }

    // 2. 第一轮：手机号登录并绑定临时邮箱（不取 token）
    oauthService.regeneratePKCE();
    const bindEmailAuthUrl = oauthService.getAuthUrl();
    console.log(`[阶段2] 绑定邮箱 OAuth URL: ${bindEmailAuthUrl.substring(0, 100)}...`);

    // 3. 导航到 OAuth 页面并完成邮箱绑定
    await browserService.navigateToOAuth(bindEmailAuthUrl);
    await browserService.oauthLoginAndAuthorize({
        loginMethod: 'phone',
        stopAfterEmailBound: true,
        phone: smsProvider.getPhone(),
        phoneCountry: SELECTED_PHONE_COUNTRY || resolvePhoneCountryForPhone(smsProvider.getPhone()),
        email: mailProvider.getEmail(),
        password: userData.password,
        fullName: userData.fullName,
        age: userData.age,
        birthDate: userData.birthDate,
        redirectUri: oauthService.redirectUri,
        onSmsNeeded: async () => {
            console.log('[阶段2]（绑定邮箱）需要 SMS 验证码...');
            return await smsProvider.pollForCode({ interval: SMS_POLL_INTERVAL, maxAttempts: SMS_MAX_ATTEMPTS });
        },
        onEmailCodeNeeded: async () => {
            console.log('[阶段2]（绑定邮箱）需要邮箱验证码...');
            return await pollEmailCode(mailProvider);
        },
    });
    console.log('[阶段2] 临时邮箱绑定完成');

    return {
        email: mailProvider.getEmail(),
    };
}

/**
 * 第三阶段：重新进入 Codex OAuth（临时邮箱登录并获取 token）
 */
async function phase3(smsProvider, mailProvider, browserService, oauthService, userData, runContext = null) {
    console.log('\n=========================================');
    console.log('[阶段3] 开始 Codex OAuth（临时邮箱登录获取 Token）');
    console.log('=========================================');

    if (!mailProvider.getEmail()) {
        throw new Error('阶段3失败：未检测到已绑定的临时邮箱，请先执行阶段2');
    }

    console.log('[阶段3] 重新发起 Codex OAuth（邮箱登录）...');
    if (runContext) {
        runContext.stage = 'phase3_email_oauth';
        runContext.email = mailProvider.getEmail();
    }

    // 重新生成 PKCE，使用临时邮箱登录并获取授权码
    oauthService.regeneratePKCE();
    const authUrl = oauthService.getAuthUrl();
    console.log(`[阶段3] OAuth URL(邮箱登录): ${authUrl.substring(0, 100)}...`);
    await browserService.navigateToOAuth(authUrl);

    // 一站式登录 + 授权（邮箱登录）
    const callbackUrl = await browserService.oauthLoginAndAuthorize({
        loginMethod: 'email',
        phone: smsProvider.getPhone(),
        phoneCountry: SELECTED_PHONE_COUNTRY || resolvePhoneCountryForPhone(smsProvider.getPhone()),
        email: mailProvider.getEmail(),
        password: userData.password,
        fullName: userData.fullName,
        age: userData.age,
        birthDate: userData.birthDate,
        redirectUri: oauthService.redirectUri,
        onSmsNeeded: async () => {
            console.log('[阶段3] 需要 SMS 验证码...');
            return await smsProvider.pollForCode({ interval: SMS_POLL_INTERVAL, maxAttempts: SMS_MAX_ATTEMPTS });
        },
        onEmailCodeNeeded: async () => {
            console.log('[阶段3] 需要邮箱验证码...');
            return await pollEmailCode(mailProvider);
        },
    });

    console.log(`[阶段3] 回调 URL: ${callbackUrl}`);

    // 提取授权参数
    const params = oauthService.extractCallbackParams(callbackUrl);
    if (!params || params.error) {
        throw new Error(`OAuth 授权失败: ${params?.error_description || params?.error || '未知错误'}`);
    }
    if (!params.code) {
        throw new Error('回调 URL 中未找到授权码');
    }

    console.log(`[阶段3] 成功获取授权码: ${params.code.substring(0, 10)}...`);

    // 用授权码换取 Token
    const tokenData = await oauthService.exchangeTokenAndSave(params.code, mailProvider.getEmail());
    return tokenData;
}

/**
 * 单次注册流程
 */
async function runSingleRegistration() {
    console.log('\n=========================================');
    console.log('[主程序] 开始一次全新的注册与授权流程');
    console.log('=========================================');
    const selectedMailDomain = pickMailDomain() || config.mailDomain;
    if (!selectedMailDomain) {
        throw new Error('未配置可用邮箱域名，请填写 mailDomain 或 mailDomains');
    }
    console.log(`[Mail] 本轮使用邮箱域名: ${selectedMailDomain}`);
    const runContext = {
        stage: 'init',
        phone: '',
        email: '',
        name: '',
        country: '',
        phoneCountryCode: '',
        smsOperator: SELECTED_SMS_OPERATOR || '',
        mailDomain: selectedMailDomain,
    };

    const smsProvider = new SMSProvider(config.heroSmsApiKey);
    const mailProvider = new MailProvider({
        baseUrl: config.mailBaseUrl,
        adminPassword: config.mailAdminPassword,
        sitePassword: config.mailSitePassword,
        domain: selectedMailDomain,
        provider: config.mailProvider,
        adminEmail: config.mailAdminEmail,
        adminToken: config.mailAdminToken,
        userType: config.mailUserType,
    });
    const baseProxy = config.proxyHost ? {
        host: config.proxyHost,
        port: config.proxyPort,
        username: config.proxyUsername,
        password: config.proxyPassword,
    } : null;
    let browserService = null;
    let oauthService = null;

    const createServices = (useProxy) => {
        const proxy = useProxy ? baseProxy : null;
        const b = new BrowserService(proxy, {
            useChrome: config.useChrome,
            chromePath: config.chromePath,
        });
        const oauthProxy = proxy ? {
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
        } : null;
        const o = new OAuthService({ proxy: oauthProxy });
        return { b, o };
    };

    const executeFlow = async () => {
        if (PHASE2_ONLY) {
            // --phase2 模式：使用已注册的账号跑 Phase 1.5 + Phase 2
            const account = await choosePhase2Account();
            if (!account) {
                throw new Error('accounts.json 中没有可用于 phase2 的账号');
            }
            console.log(`[主程序] Phase2 模式: 使用账号 ${account.phone} (${account.name})`);
            smsProvider.phoneNumber = account.phone;
            SELECTED_SMS_OPERATOR = String(account.smsOperator || '').trim();
            const phoneCountry = resolvePhoneCountryForPhone(account.phone, {
                isoCode: account.phoneCountryCode,
                dialCode: account.phoneCountryDialCode,
                name: account.phoneCountryName,
                heroSmsCountry: account.heroSmsCountry,
            });
            SELECTED_PHONE_COUNTRY = phoneCountry;
            const userData = {
                fullName: account.name,
                password: account.password,
                birthDate: account.birthDate,
                age: new Date().getFullYear() - parseInt(account.birthDate),
            };
            Object.assign(runContext, {
                stage: 'phase2_resume',
                phone: account.phone,
                name: account.name,
                phoneCountryCode: phoneCountry?.isoCode || '',
                smsOperator: SELECTED_SMS_OPERATOR || '',
            });

            // 先完成首次登录 about-you
            runContext.stage = 'phase1_5_resume';
            await phase1_5(smsProvider, browserService, userData, phoneCountry);

            let phase2Data;
            try {
                phase2Data = await phase2(smsProvider, mailProvider, browserService, oauthService, userData, runContext);
            } catch (error) {
                updateAccountStatus(account.phone, 'oauth_phase2_failed');
                throw error;
            }
            updateAccountStatus(account.phone, 'email_bound');
            saveUsernameFile({
                email: phase2Data.email,
                phone: account.phone,
                password: account.password,
                name: account.name,
                birthDate: account.birthDate,
                status: 'email_bound',
                phoneCountry,
                smsOperator: account.smsOperator || SELECTED_SMS_OPERATOR || '',
            });

            console.log('[主程序] Phase2 完成，已停在邮箱绑定收尾状态');
            console.log(`[主程序] 已绑定邮箱: ${phase2Data.email}`);
            return true;
        }

        // 正常模式：Phase 1 + Phase 1.5 + Phase 2
        const userData = generateUserData();
        console.log(`[主程序] 用户: ${userData.fullName}, 年龄: ${userData.age}, 生日: ${userData.birthDate}`);
        const phoneCountry = SELECTED_PHONE_COUNTRY || getDefaultPhoneCountry();
        console.log(`[SMS] 本轮使用国家: ${phoneCountry.name} (+${phoneCountry.dialCode}), HeroSMS 国家ID=${phoneCountry.heroSmsCountry}`);
        console.log(`[SMS] 本轮使用运营商: ${SELECTED_SMS_OPERATOR || '任何运营商'}`);
        Object.assign(runContext, {
            name: userData.fullName,
            phoneCountryCode: phoneCountry?.isoCode || '',
            smsOperator: SELECTED_SMS_OPERATOR || '',
        });

        // 1. 第一阶段：手机号注册
        runContext.stage = 'phase1_register';
        await phase1(smsProvider, browserService, userData, phoneCountry);
        runContext.phone = smsProvider.getPhone();
        runContext.smsOperator = SELECTED_SMS_OPERATOR || '';

        // 1.5. 首次登录完成个人资料
        runContext.stage = 'phase1_5_profile';
        await phase1_5(smsProvider, browserService, userData, phoneCountry);

        // 2. 第二阶段：手机号登录并绑定临时邮箱
        let phase2Data;
        try {
            phase2Data = await phase2(smsProvider, mailProvider, browserService, oauthService, userData, runContext);
        } catch (error) {
            updateAccountStatus(smsProvider.getPhone(), 'oauth_phase2_failed');
            throw error;
        }
        updateAccountStatus(smsProvider.getPhone(), 'email_bound');
        saveUsernameFile({
            email: phase2Data.email,
            phone: smsProvider.getPhone(),
            password: userData.password,
            name: userData.fullName,
            birthDate: userData.birthDate,
            status: 'email_bound',
            phoneCountry,
            smsOperator: SELECTED_SMS_OPERATOR || '',
        });

        if (STOP_AFTER_PHASE2) {
            await finalizeSmsActivation(smsProvider);
            console.log('[主程序] 已按 --stop-after-phase2 停在第二阶段收尾状态');
            console.log(`[主程序] 已绑定邮箱: ${phase2Data.email}`);
            return true;
        }

        // 3. 第三阶段：临时邮箱登录并获取 token
        const tokenData = await phase3(smsProvider, mailProvider, browserService, oauthService, userData, runContext);

        await finalizeSmsActivation(smsProvider);
        updateAccountStatus(smsProvider.getPhone(), 'oauth_done');
        console.log('[主程序] 本次注册流程圆满结束！');
        console.log(`[主程序] Token 已保存，邮箱: ${tokenData.email}`);
        return true;
    };

    try {
        const hasProxy = !!baseProxy;

        // 优先走配置代理
        ({ b: browserService, o: oauthService } = createServices(hasProxy));
        await browserService.launch();
        try {
            return await executeFlow();
        } catch (error) {
            if (hasProxy && isProxyConnectionError(error)) {
                console.warn('[主程序] 检测到代理连接失败，自动切换为直连重试本轮任务...');
                await browserService.close().catch(() => {});
                ({ b: browserService, o: oauthService } = createServices(false));
                await browserService.launch();
                return await executeFlow();
            }
            throw error;
        }

    } catch (error) {
        error.runContext = { ...(error.runContext || {}), ...runContext };
        console.error('[主程序] 本次任务执行失败:', error.message);
        throw error;
    } finally {
        await browserService.close();
    }
}

/**
 * 检查 token 数量
 */
async function runPhase8ForEntry(entry, index, total) {
    const email = String(entry?.email || '').trim();
    if (!email) {
        throw new Error('Phase8 entry is missing email');
    }

    const mailProvider = new MailProvider({
        baseUrl: config.mailBaseUrl,
        adminPassword: config.mailAdminPassword,
        sitePassword: config.mailSitePassword,
        domain: config.mailDomain,
        provider: config.mailProvider,
        adminEmail: config.mailAdminEmail,
        adminToken: config.mailAdminToken,
        userType: config.mailUserType,
    });

    const baseProxy = config.proxyHost ? {
        host: config.proxyHost,
        port: config.proxyPort,
        username: config.proxyUsername,
        password: config.proxyPassword,
    } : null;

    const createServices = (useProxy) => {
        const proxy = useProxy ? baseProxy : null;
        const b = new BrowserService(proxy, {
            useChrome: config.useChrome,
            chromePath: config.chromePath,
        });
        const oauthProxy = proxy ? {
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
        } : null;
        const o = new OAuthService({ proxy: oauthProxy });
        return { b, o };
    };

    let browserService = null;
    let oauthService = null;

    const userData = {
        fullName: String(entry?.name || email.split('@')[0] || 'user').trim(),
        password: String(entry?.password || '').trim(),
        birthDate: String(entry?.birthDate || '1996-01-01').trim(),
        age: calcAgeFromBirthDate(entry?.birthDate),
    };

    const executeFlow = async () => {
        oauthService.regeneratePKCE();
        const authUrl = oauthService.getAuthUrl();
        console.log(`[Phase8] (${index}/${total}) OAuth URL: ${authUrl.substring(0, 100)}...`);
        await browserService.navigateToOAuth(authUrl);

        const callbackUrl = await browserService.oauthLoginAndAuthorize({
            loginMethod: 'email',
            preferEmailOtp: true,
            phone: String(entry?.phone || ''),
            email,
            password: userData.password,
            fullName: userData.fullName,
            age: userData.age,
            birthDate: userData.birthDate,
            redirectUri: oauthService.redirectUri,
            onEmailCodeNeeded: async () => {
                console.log(`[Phase8] (${index}/${total}) waiting latest code from ${email}...`);
                return await pollEmailCodeByAddress(mailProvider, email);
            },
            onSmsNeeded: async () => {
                throw new Error('Phase8 hit SMS verification, treated as failed');
            },
        });

        console.log(`[Phase8] (${index}/${total}) callback: ${callbackUrl}`);
        const params = oauthService.extractCallbackParams(callbackUrl);
        if (!params || params.error) {
            throw new Error(`OAuth failed: ${params?.error_description || params?.error || 'unknown'}`);
        }
        if (!params.code) {
            throw new Error('OAuth callback missing code');
        }

        const tokenData = await oauthService.exchangeTokenAndSave(params.code, email);
        console.log(`[Phase8] (${index}/${total}) token saved for ${tokenData.email}`);
        return tokenData;
    };

    try {
        const hasProxy = !!baseProxy;
        ({ b: browserService, o: oauthService } = createServices(hasProxy));
        await browserService.launch();

        try {
            const tokenData = await executeFlow();
            updateUsernameStatus(email, 'oauth_done');
            return tokenData;
        } catch (error) {
            if (hasProxy && isProxyConnectionError(error)) {
                console.warn('[Phase8] proxy failed, retry this account without proxy...');
                await browserService.close().catch(() => {});
                ({ b: browserService, o: oauthService } = createServices(false));
                await browserService.launch();
                const tokenData = await executeFlow();
                updateUsernameStatus(email, 'oauth_done');
                return tokenData;
            }
            updateUsernameStatus(email, 'oauth_phase3_failed');
            throw error;
        }
    } finally {
        if (browserService) {
            await browserService.close().catch(() => {});
        }
    }
}

async function startPhase8() {
    console.log('[Start] Phase8 mode: iterate username.json and fetch token by email OTP');

    assertNotRunningWithXvfb();

    if (!config.mailBaseUrl || getConfiguredMailDomains().length === 0) {
        throw new Error('Phase8 requires mailBaseUrl and mailDomain/mailDomains in config');
    }
    if (TOKEN_AUTH_MAIL_PROVIDERS.has(MAIL_PROVIDER)) {
        if (!config.mailAdminToken && !config.mailAdminPassword) {
            throw new Error(`Phase8 ${MAIL_PROVIDER} requires mailAdminToken or mailAdminPassword`);
        }
    } else if (!config.mailAdminPassword) {
        throw new Error('Phase8 legacy mail provider requires mailAdminPassword');
    }

    const records = getUsernameRecords();
    if (records.length === 0) {
        console.log('[Phase8] username.json is empty');
        return;
    }

    let success = 0;
    let failed = 0;

    for (let i = 0; i < records.length; i++) {
        const entry = records[i];
        const idx = i + 1;
        console.log(`\\n[Phase8] ===== ${idx}/${records.length} =====`);
        console.log(`[Phase8] email: ${entry?.email || '(empty)'}`);

        try {
            await runPhase8ForEntry(entry, idx, records.length);
            success++;
        } catch (error) {
            failed++;
            console.error(`[Phase8] (${idx}/${records.length}) failed: ${error.message}`);
            appendFailedToShibai(entry);
        }

        if (i < records.length - 1) {
            console.log(`[Phase8] wait ${PHASE8_ACCOUNT_DELAY_MS / 1000}s before next account...`);
            await new Promise(r => setTimeout(r, PHASE8_ACCOUNT_DELAY_MS));
        }
    }

    console.log(`\\n[Phase8] done: success=${success}, failed=${failed}, total=${records.length}`);
}

async function startPhase3Only() {
    console.log('[Start] Phase3 mode: use latest username.json record and fetch token by email OTP');

    assertNotRunningWithXvfb();

    if (!config.mailBaseUrl || getConfiguredMailDomains().length === 0) {
        throw new Error('Phase3 requires mailBaseUrl and mailDomain/mailDomains in config');
    }
    if (TOKEN_AUTH_MAIL_PROVIDERS.has(MAIL_PROVIDER)) {
        if (!config.mailAdminToken && !config.mailAdminPassword) {
            throw new Error(`Phase3 ${MAIL_PROVIDER} requires mailAdminToken or mailAdminPassword`);
        }
    } else if (!config.mailAdminPassword) {
        throw new Error('Phase3 legacy mail provider requires mailAdminPassword');
    }

    const entry = await choosePhase3Entry();
    if (!entry) {
        throw new Error('username.json 中没有可用于 phase3 的记录');
    }

    console.log(`[Phase3] selected email: ${entry?.email || '(empty)'}`);
    await runPhase8ForEntry(entry, 1, 1);
    console.log('[Phase3] done');
}

async function checkTokenCount() {
    if (!fs.existsSync(TOKEN_OUTPUT_DIR)) return 0;
    return fs.readdirSync(TOKEN_OUTPUT_DIR).filter(f => f.startsWith('codex-') && f.endsWith('-free.json')).length;
}

/**
 * 归档已有 tokens
 */
function archiveExistingTokens() {
    if (!fs.existsSync(TOKEN_OUTPUT_DIR)) return;
    const files = fs.readdirSync(TOKEN_OUTPUT_DIR).filter(f => f.startsWith('codex-') && f.endsWith('-free.json'));
    for (const file of files) {
        fs.renameSync(path.join(TOKEN_OUTPUT_DIR, file), path.join(TOKEN_OUTPUT_DIR, `old_${file}`));
        console.log(`[归档] ${file} → old_${file}`);
    }
}

/**
 * 启动批量注册
 */
async function startBatch() {
    console.log(`[启动] Codex 远程注册机（手机号 + Puppeteer 模式），目标: ${TARGET_COUNT}`);
    BATCH_FAILURES.length = 0;

    assertNotRunningWithXvfb();

    if (!config.heroSmsApiKey) {
        console.error('[错误] 未配置 heroSmsApiKey');
        process.exit(1);
    }
    if (!config.mailBaseUrl) {
        console.error('[错误] 未配置 mailBaseUrl');
        process.exit(1);
    }
    if (getConfiguredMailDomains().length === 0) {
        console.error('[错误] 未配置 mailDomain 或 mailDomains');
        process.exit(1);
    }
    if (TOKEN_AUTH_MAIL_PROVIDERS.has(MAIL_PROVIDER)) {
        if (!config.mailAdminToken && !config.mailAdminPassword) {
            console.error(`[错误] ${MAIL_PROVIDER} 需要配置 mailAdminToken 或 mailAdminPassword`);
            process.exit(1);
        }
    } else if (!config.mailAdminPassword) {
        console.error('[错误] 未配置 mailAdminPassword');
        process.exit(1);
    }

    if (!PHASE2_ONLY) {
        SELECTED_PHONE_COUNTRY = await resolveRunPhoneCountry();
        const operatorSelection = await resolveRunSmsOperator(SELECTED_PHONE_COUNTRY);
        SELECTED_SMS_OPERATOR = operatorSelection?.operator || '';
    }

    if (PHASE2_ONLY || STOP_AFTER_PHASE2) {
        const target = PHASE2_ONLY ? 1 : TARGET_COUNT;
        let completed = 0;
        while (completed < target) {
            console.log(`\n[进度] Phase2 ${completed} / ${target}`);
            try {
                await runSingleRegistration();
                completed++;
            } catch (error) {
                BATCH_FAILURES.push(buildRunContextSummary(error?.runContext || {}, error));
                const shouldRetryImmediately = !!error?.noRetryDelay
                    || error?.code === 'SMS_ACTIVATION_CANCELLED'
                    || error?.code === 'SMS_CODE_TIMEOUT_CANCELLED'
                    || error?.code === 'PHONE_ALREADY_REGISTERED';
                if (shouldRetryImmediately) {
                    console.error('[主程序] Phase2 流程失败，立即进入下一轮...');
                    continue;
                }
                console.error('[主程序] Phase2 流程失败，30 秒后重试...');
                await new Promise(r => setTimeout(r, 30000));
            }
        }

        console.log(`\n[完成] Phase2 收尾数量 (${completed}) 已达目标 (${target})。`);
        if (BATCH_FAILURES.length > 0) {
            printBatchFailureSummary(BATCH_FAILURES);
        }
        return;
    }

    archiveExistingTokens();

    while (true) {
        const currentCount = await checkTokenCount();
        if (currentCount >= TARGET_COUNT) {
            console.log(`\n[完成] Token 数量 (${currentCount}) 已达目标 (${TARGET_COUNT})。`);
            break;
        }

        console.log(`\n[进度] ${currentCount} / ${TARGET_COUNT}`);

        try {
            await runSingleRegistration();
        } catch (error) {
            BATCH_FAILURES.push(buildRunContextSummary(error?.runContext || {}, error));
            const shouldRetryImmediately = !!error?.noRetryDelay
                || error?.code === 'SMS_ACTIVATION_CANCELLED'
                || error?.code === 'SMS_CODE_TIMEOUT_CANCELLED'
                || error?.code === 'PHONE_ALREADY_REGISTERED';
            if (shouldRetryImmediately) {
                console.error('[主程序] 注册失败，立即进入下一轮...');
                continue;
            }
            console.error('[主程序] 注册失败，30 秒后重试...');
            await new Promise(r => setTimeout(r, 30000));
        }
    }

    if (BATCH_FAILURES.length > 0) {
        printBatchFailureSummary(BATCH_FAILURES);
    }
}

async function main() {
    if (TEST_SMS_COUNTRY_ONLY) {
        await runSmsCountryDebug();
        return;
    }
    if (PHASE3_ONLY) {
        await startPhase3Only();
        return;
    }
    if (PHASE8_ONLY) {
        await startPhase8();
        return;
    }
    await startBatch();
}

main().catch(console.error);
