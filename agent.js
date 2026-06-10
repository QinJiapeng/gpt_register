const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const ROOT_DIR = __dirname;
const AGENT_CONFIG_FILE = path.join(ROOT_DIR, 'config.agent.json');
const MAIN_SCRIPT = path.join(ROOT_DIR, 'index.js');
const LOCK_FILE = path.join(ROOT_DIR, 'agent.lock');

const DEFAULT_CONFIG = {
    baseUrl: '',
    token: '',
    workerId: `${os.hostname()}-${process.platform}`,
    pollIntervalMs: 10000,
    requestTimeoutMs: 30000,
    nextJobPath: '/api/agent/jobs/next',
    statusPathTemplate: '/api/agent/jobs/{id}/status',
    authFileUploadUrl: '',
    authFileUploadToken: '',
    authFileUploadField: 'file',
    authFileUploadDirs: ['tokens'],
    authFileUploadMaxFiles: 100,
    authFileUploadMaxBytes: 2 * 1024 * 1024,
    authFileArchiveDir: 'tokens_old',
};

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`配置文件解析失败: ${filePath} -> ${error.message}`);
    }
}

function loadAgentConfig() {
    const fileConfig = readJsonIfExists(AGENT_CONFIG_FILE);
    const config = {
        ...DEFAULT_CONFIG,
        ...fileConfig,
    };

    config.baseUrl = process.env.AGENT_BASE_URL || config.baseUrl;
    config.token = process.env.AGENT_TOKEN || config.token;
    config.workerId = process.env.AGENT_WORKER_ID || config.workerId;
    config.pollIntervalMs = Number(process.env.AGENT_POLL_INTERVAL_MS || config.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs;
    config.requestTimeoutMs = Number(process.env.AGENT_REQUEST_TIMEOUT_MS || config.requestTimeoutMs) || DEFAULT_CONFIG.requestTimeoutMs;
    config.authFileUploadUrl = process.env.AUTH_FILE_UPLOAD_URL || config.authFileUploadUrl;
    config.authFileUploadToken = process.env.AUTH_FILE_UPLOAD_TOKEN || config.authFileUploadToken;
    config.authFileUploadField = process.env.AUTH_FILE_UPLOAD_FIELD || config.authFileUploadField || DEFAULT_CONFIG.authFileUploadField;
    config.authFileArchiveDir = process.env.AUTH_FILE_ARCHIVE_DIR || config.authFileArchiveDir || DEFAULT_CONFIG.authFileArchiveDir;

    if (!config.baseUrl) {
        throw new Error('缺少远程任务地址。请设置 config.agent.json 的 baseUrl，或设置 AGENT_BASE_URL。');
    }

    config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    config.authFileUploadUrl = String(config.authFileUploadUrl || '').trim();
    return config;
}

function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildUrl(config, pathTemplate, params = {}) {
    let pathname = pathTemplate;
    for (const [key, value] of Object.entries(params)) {
        pathname = pathname.replace(`{${key}}`, encodeURIComponent(String(value)));
    }
    if (!pathname.startsWith('/')) pathname = `/${pathname}`;
    return `${config.baseUrl}${pathname}`;
}

function authHeaders(config) {
    const headers = {
        'User-Agent': `gpt-register-agent/1.0 (${config.workerId})`,
    };
    if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
    }
    return headers;
}

function createClient(config) {
    return axios.create({
        timeout: config.requestTimeoutMs,
        headers: authHeaders(config),
        validateStatus: status => status >= 200 && status < 500,
    });
}

async function fetchNextJob(client, config) {
    const url = buildUrl(config, config.nextJobPath);
    const response = await client.get(url, {
        params: {
            workerId: config.workerId,
            hostname: os.hostname(),
            platform: process.platform,
        },
    });

    if (response.status === 204) return null;
    if (response.status >= 400) {
        throw new Error(`拉取任务失败: HTTP ${response.status} ${stringifyResponse(response.data)}`);
    }

    const data = response.data || {};
    if (Object.prototype.hasOwnProperty.call(data, 'job')) return data.job;
    if (Object.prototype.hasOwnProperty.call(data, 'task')) return data.task;
    if (!data.id && !data.jobId && !data.taskId) return null;
    return data;
}

async function reportStatus(client, config, jobId, status, extra = {}) {
    const url = buildUrl(config, config.statusPathTemplate, { id: jobId });
    const response = await client.post(url, {
        workerId: config.workerId,
        status,
        ...extra,
    });

    if (response.status >= 400) {
        console.warn(`[Agent] 状态上报失败: job=${jobId}, status=${status}, HTTP ${response.status}`);
    }
}

function stringifyResponse(value) {
    if (typeof value === 'string') return value.slice(0, 300);
    try {
        return JSON.stringify(value).slice(0, 300);
    } catch (error) {
        return '';
    }
}

function normalizeJob(job) {
    if (!job || typeof job !== 'object') return null;
    const id = job.id || job.jobId || job.taskId;
    if (!id) throw new Error('远程任务缺少 id/jobId/taskId');

    const command = String(job.command || job.type || 'run').trim().toLowerCase();
    if (!['run', 'start'].includes(command)) {
        throw new Error(`不支持的任务类型: ${command}`);
    }

    const args = Array.isArray(job.args) && job.args.length > 0
        ? sanitizeRawArgs(job.args)
        : buildArgsFromStructuredJob(job);

    const env = {};
    if (job.configProfile) {
        const profile = String(job.configProfile).trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
            throw new Error(`非法 configProfile: ${profile}`);
        }
        env.CONFIG_PROFILE = profile;
    }

    return {
        id: String(id),
        args,
        env,
        raw: job,
    };
}

function sanitizeRawArgs(args) {
    return args.map(arg => String(arg)).filter(Boolean).map(normalizeArg);
}

function normalizeArg(arg) {
    if (/^\d+$/.test(arg)) {
        const count = Number(arg);
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            throw new Error(`任务数量超出允许范围: ${arg}`);
        }
        return String(count);
    }

    if (/^--country=/.test(arg)) {
        const country = arg.split('=')[1] || '';
        if (!/^[A-Z]{2}$/i.test(country)) {
            throw new Error(`非法国家代码: ${country}`);
        }
        return `--country=${country.toUpperCase()}`;
    }

    const allowedFlags = new Set([
        '--phase2',
        '--phase3',
        '--phase8',
        '--stop-after-phase2',
        '--test-sms-country',
    ]);
    if (allowedFlags.has(arg)) return arg;

    throw new Error(`远程参数不在白名单内: ${arg}`);
}

function buildArgsFromStructuredJob(job) {
    const args = [];
    const mode = String(job.mode || 'full').trim().toLowerCase();

    if (mode === 'full') {
        const count = Number(job.count || 1);
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            throw new Error(`任务数量超出允许范围: ${job.count}`);
        }
        args.push(String(count));
    } else if (mode === 'phase2') {
        args.push('--phase2');
    } else if (mode === 'phase3') {
        args.push('--phase3');
    } else if (mode === 'phase8') {
        args.push('--phase8');
    } else if (mode === 'stop-after-phase2') {
        const count = Number(job.count || 1);
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            throw new Error(`任务数量超出允许范围: ${job.count}`);
        }
        args.push(String(count), '--stop-after-phase2');
    } else if (mode === 'test-sms-country') {
        args.push('--test-sms-country');
    } else {
        throw new Error(`不支持的运行模式: ${mode}`);
    }

    if (job.country) {
        const country = String(job.country).trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(country)) {
            throw new Error(`非法国家代码: ${job.country}`);
        }
        args.push(`--country=${country}`);
    }

    return args;
}

function ensureNoStaleLock() {
    if (!fs.existsSync(LOCK_FILE)) return;

    try {
        const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        const pid = Number(lock.pid);
        if (pid && isProcessRunning(pid)) {
            throw new Error(`已有任务正在运行，pid=${pid}, job=${lock.jobId || '-'}`);
        }
    } catch (error) {
        if (error.message.includes('已有任务正在运行')) throw error;
    }

    fs.rmSync(LOCK_FILE, { force: true });
}

function writeLock(jobId) {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
        pid: process.pid,
        jobId,
        startedAt: new Date().toISOString(),
    }, null, 2));
}

function clearLock() {
    fs.rmSync(LOCK_FILE, { force: true });
}

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return false;
    }
}

function snapshotUploadFiles(config) {
    const snapshot = new Map();
    for (const filePath of listUploadCandidates(config)) {
        try {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                snapshot.set(filePath, `${stat.mtimeMs}:${stat.size}`);
            }
        } catch (error) {
            // Ignore files that disappear while the script is running.
        }
    }
    return snapshot;
}

function listUploadCandidates(config) {
    const paths = [];
    const dirs = Array.isArray(config.authFileUploadDirs)
        ? config.authFileUploadDirs
        : DEFAULT_CONFIG.authFileUploadDirs;

    for (const dir of dirs) {
        const absDir = resolveInsideRoot(dir);
        if (!absDir || !fs.existsSync(absDir)) continue;
        walkJsonFiles(absDir, paths);
    }

    return paths;
}

function walkJsonFiles(dir, out) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkJsonFiles(fullPath, out);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
            out.push(fullPath);
        }
    }
}

function resolveInsideRoot(relativePath) {
    const absPath = path.resolve(ROOT_DIR, String(relativePath || ''));
    const relative = path.relative(ROOT_DIR, absPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        console.warn(`[Agent] 跳过工作区外上传路径: ${relativePath}`);
        return '';
    }
    return absPath;
}

function collectChangedUploadFiles(config, beforeSnapshot) {
    const changed = [];
    const maxFiles = Number(config.authFileUploadMaxFiles) || DEFAULT_CONFIG.authFileUploadMaxFiles;
    const maxBytes = Number(config.authFileUploadMaxBytes) || DEFAULT_CONFIG.authFileUploadMaxBytes;

    for (const filePath of listUploadCandidates(config)) {
        if (changed.length >= maxFiles) break;

        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (error) {
            continue;
        }

        const signature = `${stat.mtimeMs}:${stat.size}`;
        if (beforeSnapshot.get(filePath) === signature) continue;
        if (stat.size > maxBytes) {
            console.warn(`[Agent] 跳过过大的认证文件: ${path.relative(ROOT_DIR, filePath)} (${stat.size} bytes)`);
            continue;
        }

        changed.push(filePath);
    }

    return changed;
}

function archiveUploadedAuthFile(config, filePath) {
    const archiveRoot = resolveInsideRoot(config.authFileArchiveDir);
    if (!archiveRoot) {
        throw new Error(`归档目录不在工作区内: ${config.authFileArchiveDir}`);
    }

    const relativePath = path.relative(ROOT_DIR, filePath);
    const segments = relativePath.split(path.sep);
    if (segments[0] === 'tokens') segments.shift();

    const targetPath = path.resolve(archiveRoot, ...segments);
    const targetRelative = path.relative(ROOT_DIR, targetPath);
    if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
        throw new Error(`归档目标不在工作区内: ${targetPath}`);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(filePath, targetPath);
    return targetPath;
}

async function uploadAuthFiles(config, job, filePaths) {
    if (!config.authFileUploadUrl || filePaths.length === 0) return { uploaded: 0, failed: [] };

    const uploaded = [];
    const failed = [];

    for (const filePath of filePaths) {
        const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
        try {
            const form = new FormData();
            const content = fs.readFileSync(filePath);
            const blob = new Blob([content], { type: 'application/json' });
            form.append(config.authFileUploadField, blob, path.basename(filePath));
            form.append('jobId', job.id);
            form.append('workerId', config.workerId);
            form.append('path', relativePath);

            const headers = {};
            if (config.authFileUploadToken) {
                headers.Authorization = `Bearer ${config.authFileUploadToken}`;
            }

            const response = await fetch(config.authFileUploadUrl, {
                method: 'POST',
                headers,
                body: form,
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status} ${body.slice(0, 300)}`);
            }

            const archivedPath = archiveUploadedAuthFile(config, filePath);
            uploaded.push(relativePath);
            console.log(`[Agent] 已上传认证文件: ${relativePath}`);
            console.log(`[Agent] 已复制到归档目录: ${path.relative(ROOT_DIR, archivedPath).replace(/\\/g, '/')}`);
        } catch (error) {
            failed.push({ path: relativePath, error: error.message });
            console.warn(`[Agent] 上传认证文件失败: ${relativePath} -> ${error.message}`);
        }
    }

    return { uploaded: uploaded.length, failed };
}

function runMainScript(job) {
    return new Promise((resolve) => {
        const outputLimit = 20000;
        let stdoutTail = '';
        let stderrTail = '';

        console.log(`[Agent] 启动任务 ${job.id}: node index.js ${job.args.join(' ')}`);
        const child = spawn(process.execPath, [MAIN_SCRIPT, ...job.args], {
            cwd: ROOT_DIR,
            env: {
                ...process.env,
                ...job.env,
            },
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', chunk => {
            const text = chunk.toString();
            process.stdout.write(text);
            stdoutTail = keepTail(stdoutTail + text, outputLimit);
        });

        child.stderr.on('data', chunk => {
            const text = chunk.toString();
            process.stderr.write(text);
            stderrTail = keepTail(stderrTail + text, outputLimit);
        });

        child.on('error', error => {
            stderrTail = keepTail(`${stderrTail}\n${error.stack || error.message}`, outputLimit);
        });

        child.on('close', (code, signal) => {
            resolve({
                exitCode: code,
                signal,
                stdoutTail,
                stderrTail,
            });
        });
    });
}

function keepTail(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.slice(text.length - maxLength);
}

async function executeJob(client, config, job) {
    ensureNoStaleLock();
    writeLock(job.id);

    const startedAt = new Date().toISOString();
    const beforeUploadSnapshot = snapshotUploadFiles(config);
    try {
        await reportStatus(client, config, job.id, 'running', {
            startedAt,
            args: job.args,
            configProfile: job.env.CONFIG_PROFILE || '',
        });

        const result = await runMainScript(job);
        const finishedAt = new Date().toISOString();
        const changedFiles = collectChangedUploadFiles(config, beforeUploadSnapshot);
        const uploadResult = await uploadAuthFiles(config, job, changedFiles);
        const uploadSummary = uploadResult.uploaded || uploadResult.failed.length
            ? `\n[Agent] auth file upload: uploaded=${uploadResult.uploaded}, failed=${uploadResult.failed.length}`
            : '';
        const uploadErrors = uploadResult.failed.length
            ? `\n${uploadResult.failed.map(item => `${item.path}: ${item.error}`).join('\n')}`
            : '';

        const ok = result.exitCode === 0;
        await reportStatus(client, config, job.id, ok ? 'success' : 'failed', {
            finishedAt,
            exitCode: result.exitCode,
            signal: result.signal,
            stdoutTail: keepTail(`${result.stdoutTail}${uploadSummary}`, 20000),
            stderrTail: keepTail(`${result.stderrTail}${uploadErrors}`, 20000),
        });

        console.log(`[Agent] 任务 ${job.id} ${ok ? '完成' : '失败'}，exitCode=${result.exitCode}, uploaded=${uploadResult.uploaded}`);
    } finally {
        clearLock();
    }
}

async function main() {
    const config = loadAgentConfig();
    const client = createClient(config);

    console.log(`[Agent] workerId=${config.workerId}`);
    console.log(`[Agent] 任务服务=${config.baseUrl}`);
    console.log(`[Agent] 轮询间隔=${config.pollIntervalMs}ms`);

    while (true) {
        try {
            const remoteJob = await fetchNextJob(client, config);
            if (remoteJob && Object.keys(remoteJob).length > 0) {
                const job = normalizeJob(remoteJob);
                if (job) {
                    await executeJob(client, config, job);
                }
            }
        } catch (error) {
            console.error(`[Agent] ${error.stack || error.message}`);
        }

        await sleep(config.pollIntervalMs);
    }
}

main().catch(error => {
    console.error(`[Agent] 启动失败: ${error.stack || error.message}`);
    process.exitCode = 1;
});
