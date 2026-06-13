const fs = require('fs');
const path = require('path');

const DEFAULT_UPLOAD_FIELD = 'file';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function normalizeUploadConfig(options = {}) {
    return {
        uploadUrl: String(options.uploadUrl || process.env.AUTH_FILE_UPLOAD_URL || '').trim(),
        uploadToken: String(options.uploadToken || process.env.AUTH_FILE_UPLOAD_TOKEN || '').trim(),
        uploadField: String(options.uploadField || process.env.AUTH_FILE_UPLOAD_FIELD || DEFAULT_UPLOAD_FIELD).trim() || DEFAULT_UPLOAD_FIELD,
        maxBytes: Number(options.maxBytes || process.env.AUTH_FILE_UPLOAD_MAX_BYTES) || DEFAULT_MAX_BYTES,
        jobId: String(options.jobId || process.env.AUTH_FILE_UPLOAD_JOB_ID || '').trim(),
        workerId: String(options.workerId || process.env.AUTH_FILE_UPLOAD_WORKER_ID || '').trim(),
        uploadTarget: String(options.uploadTarget || process.env.AUTH_FILE_UPLOAD_TARGET || '').trim(),
        rootDir: options.rootDir || process.cwd(),
    };
}

function resolveUploadPath(filePath, rootDir = process.cwd()) {
    const absPath = path.resolve(rootDir, String(filePath || ''));
    const relative = path.relative(rootDir, absPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`上传路径不在工作区内: ${filePath}`);
    }
    return { absPath, relativePath: relative.replace(/\\/g, '/') };
}

async function uploadAuthFile(filePath, options = {}) {
    const config = normalizeUploadConfig(options);
    if (!config.uploadUrl) {
        return { skipped: true, path: String(filePath || ''), reason: 'missing upload url' };
    }

    const { absPath, relativePath } = resolveUploadPath(filePath, config.rootDir);
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
        throw new Error(`上传路径不是文件: ${relativePath}`);
    }
    if (stat.size > config.maxBytes) {
        throw new Error(`认证文件过大: ${relativePath} (${stat.size} bytes)`);
    }

    const form = new FormData();
    const content = fs.readFileSync(absPath);
    const blob = new Blob([content], { type: 'application/json' });
    form.append(config.uploadField, blob, path.basename(absPath));
    if (config.jobId) form.append('jobId', config.jobId);
    if (config.workerId) form.append('workerId', config.workerId);
    if (config.uploadTarget) form.append('uploadTarget', config.uploadTarget);
    form.append('path', relativePath);

    const headers = {};
    if (config.uploadToken) {
        headers.Authorization = `Bearer ${config.uploadToken}`;
    }

    const response = await fetch(config.uploadUrl, {
        method: 'POST',
        headers,
        body: form,
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${body.slice(0, 300)}`);
    }

    return { skipped: false, path: relativePath };
}

async function uploadAuthFiles(filePaths = [], options = {}) {
    const uploaded = [];
    const failed = [];
    const skipped = [];

    for (const filePath of filePaths) {
        const displayPath = path.relative(options.rootDir || process.cwd(), path.resolve(options.rootDir || process.cwd(), String(filePath || ''))).replace(/\\/g, '/');
        try {
            const result = await uploadAuthFile(filePath, options);
            if (result.skipped) {
                skipped.push(result.path);
                continue;
            }
            uploaded.push(result.path);
        } catch (error) {
            failed.push({ path: displayPath, error: error.message });
        }
    }

    return { uploaded, failed, skipped };
}

module.exports = {
    normalizeUploadConfig,
    uploadAuthFile,
    uploadAuthFiles,
};
