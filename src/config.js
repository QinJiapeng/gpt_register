const path = require('path');
const fs = require('fs');
const { DEFAULT_PHONE_COUNTRIES, normalizePhoneCountries } = require('./phoneCountryCatalog');

const configPath = path.join(__dirname, '..', 'config.json');
const rootDir = path.join(__dirname, '..');

function readJsonConfig(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return {};
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error(`[Config] 解析配置文件失败: ${filePath} -> ${error.message}`);
        return {};
    }
}

function resolveProfileConfigPath() {
    const explicitFile = String(process.env.CONFIG_FILE || '').trim();
    if (explicitFile) {
        return path.isAbsolute(explicitFile)
            ? explicitFile
            : path.resolve(rootDir, explicitFile);
    }

    const profile = String(process.env.CONFIG_PROFILE || '').trim();
    if (profile) {
        return path.join(rootDir, `config.${profile}.json`);
    }

    if (process.platform === 'darwin') {
        return path.join(rootDir, 'config.local.json');
    }
    if (process.platform === 'linux') {
        return path.join(rootDir, 'config.server.json');
    }
    return '';
}

function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function parseProxyUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (!url.hostname) return null;
        const defaultPort = url.protocol === 'https:' ? 443 : 80;
        return {
            host: url.hostname,
            port: parseInt(url.port, 10) || defaultPort,
            username: decodeURIComponent(url.username || ''),
            password: decodeURIComponent(url.password || ''),
        };
    } catch (error) {
        return null;
    }
}

function normalizeMailDomains(domains, fallback = '') {
    const list = Array.isArray(domains) ? domains : [];
    const normalized = list
        .map(item => String(item || '').trim().replace(/^@/, ''))
        .filter(Boolean);

    if (normalized.length > 0) return normalized;

    const single = String(fallback || '').trim().replace(/^@/, '');
    return single ? [single] : [];
}

function resolveProjectPath(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

function parsePathList(value = '') {
    return String(value || '')
        .split(/[;,]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseOptionalNumber(value, defaultValue = null) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const num = Number(value);
    return Number.isFinite(num) ? num : defaultValue;
}

// 读取配置文件：基础 config.json + 环境覆盖文件
function loadConfig() {
    const baseConfig = readJsonConfig(configPath);
    const profileConfigPath = resolveProfileConfigPath();
    const profileConfig = profileConfigPath ? readJsonConfig(profileConfigPath) : {};

    if (profileConfigPath && fs.existsSync(profileConfigPath)) {
        console.log(`[Config] 使用覆盖配置: ${profileConfigPath}`);
    }

    if (!fs.existsSync(configPath) && (!profileConfigPath || !fs.existsSync(profileConfigPath))) {
        console.error(`[Config] 未找到可用配置文件: ${configPath}`);
    }

    return {
        ...baseConfig,
        ...profileConfig,
    };
}

const config = loadConfig();
const defaultOutlookPoolFile = path.join(rootDir, 'outlook_pool.txt');
const defaultOutlookPoolStateFile = path.join(rootDir, 'outlook_pool_state.json');
const envTokenOutputDirs = parsePathList(process.env.TOKEN_OUTPUT_DIRS);
const envTokenOutputDir = String(process.env.TOKEN_OUTPUT_DIR || '').trim();
const envProxy = parseProxyUrl(
    process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.ALL_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || process.env.all_proxy
);
const phoneCountries = normalizePhoneCountries(
    Array.isArray(config.phoneCountries) && config.phoneCountries.length > 0
        ? config.phoneCountries
        : DEFAULT_PHONE_COUNTRIES
);
const mailDomains = normalizeMailDomains(config.mailDomains, config.mailDomain);
const smsProvider = String(
    process.env.SMS_PROVIDER
    || config.smsProvider
    || (config.smsBowerApiKey || config.smsbowerApiKey || process.env.SMSBOWER_API_KEY || process.env.SMS_BOWER_API_KEY ? 'smsbower' : 'herosms')
).trim().toLowerCase();

module.exports = {
    // SMS 平台
    smsProvider: smsProvider === 'smsbower' ? 'smsbower' : 'herosms',

    // HeroSMS
    heroSmsApiKey: config.heroSmsApiKey,
    heroSmsService: config.heroSmsService || 'dr',
    heroSmsCountry: parseInt(config.heroSmsCountry, 10) || 33,
    heroSmsPromptCountrySelection: parseBoolean(config.heroSmsPromptCountrySelection, true),
    heroSmsCountryTopN: parseInt(config.heroSmsCountryTopN, 10) || 10,
    heroSmsMaxPrice: parseOptionalNumber(config.heroSmsMaxPrice),

    // SMSBower
    smsBowerApiKey: process.env.SMSBOWER_API_KEY || process.env.SMS_BOWER_API_KEY || config.smsBowerApiKey || config.smsbowerApiKey || '',
    smsBowerBaseUrl: config.smsBowerBaseUrl || config.smsbowerBaseUrl || 'https://smsbower.page/stubs/handler_api.php',
    smsBowerService: config.smsBowerService || config.smsbowerService || 'dr',
    smsBowerCountry: parseInt(config.smsBowerCountry || config.smsbowerCountry, 10) || 73,
    smsBowerPromptCountrySelection: parseBoolean(
        config.smsBowerPromptCountrySelection ?? config.smsbowerPromptCountrySelection,
        parseBoolean(config.heroSmsPromptCountrySelection, true)
    ),
    smsBowerCountryTopN: parseInt(config.smsBowerCountryTopN || config.smsbowerCountryTopN, 10) || parseInt(config.heroSmsCountryTopN, 10) || 10,
    smsBowerMaxPrice: parseOptionalNumber(config.smsBowerMaxPrice ?? config.smsbowerMaxPrice ?? config.heroSmsMaxPrice),

    // Cloudflare 临时邮箱
    mailBaseUrl: config.mailBaseUrl || '',
    mailAdminPassword: config.mailAdminPassword,
    mailSitePassword: config.mailSitePassword || '',
    mailDomain: mailDomains[0] || '',
    mailDomains,
    mailProvider: config.mailProvider || 'cloud-mail', // cloud-mail | legacy | cloudflare-worker | outlook | auto
    mailAdminEmail: config.mailAdminEmail || '',
    mailAdminToken: config.mailAdminToken || '',
    mailUserType: parseInt(config.mailUserType, 10) || 1,
    outlookPoolFile: resolveProjectPath(process.env.OUTLOOK_POOL_FILE || config.outlookPoolFile || defaultOutlookPoolFile),
    outlookPoolStateFile: resolveProjectPath(config.outlookPoolStateFile || defaultOutlookPoolStateFile),
    outlookAccounts: Array.isArray(config.outlookAccounts) ? config.outlookAccounts : [],
    outlookImapHost: config.outlookImapHost || 'outlook.office365.com',
    outlookImapPort: parseInt(config.outlookImapPort, 10) || 993,

    // 代理
    proxyHost: config.proxyHost || envProxy?.host || '',
    proxyPort: parseInt(config.proxyPort, 10) || envProxy?.port || 0,
    proxyUsername: config.proxyUsername || envProxy?.username || '',
    proxyPassword: config.proxyPassword || envProxy?.password || '',

    // OAuth
    oauthClientId: config.oauthClientId || 'app_EMoamEEZ73f0CkXaXp7hrann',
    oauthRedirectPort: parseInt(config.oauthRedirectPort, 10) || 1455,
    tokenOutputDir: envTokenOutputDir || config.tokenOutputDir || '',
    tokenOutputDirs: envTokenOutputDirs.length > 0
        ? envTokenOutputDirs
        : (Array.isArray(config.tokenOutputDirs)
            ? config.tokenOutputDirs.filter(Boolean)
            : []),

    // 浏览器
    useChrome: config.useChrome !== false,
    chromePath: config.chromePath || 'google-chrome-stable',
    browserUserDataDir: resolveProjectPath(config.browserUserDataDir || ''),
    browserIncognito: parseBoolean(config.browserIncognito, true),
    browserClearChatGptSession: parseBoolean(config.browserClearChatGptSession, false),

    // 手机国家
    phoneCountryCode: String(config.phoneCountryCode || 'CO').trim().toUpperCase(),
    phoneCountries,
};
