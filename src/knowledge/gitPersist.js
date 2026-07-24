'use strict';

// `railway up` replaces the running container with a fresh snapshot of the
// LOCAL machine's directory on every deploy — it does not pull from GitHub
// or from the container's own git history. So a knowledge doc written to
// disk by a live upload/crawl only survives if it reaches the GitHub
// remote before the next deploy. This originally shelled out to the `git`
// binary, which turned out to not exist in the Railway runtime container
// at all (`spawnSync git ENOENT` — confirmed in production logs; every
// commit attempt since this module existed silently failed and was only
// ever caught because of that log line). Rewritten to talk to GitHub's
// REST Contents API directly over HTTPS instead — no git binary
// dependency, works from any Node runtime. Requires a GITHUB_PUSH_TOKEN
// env var (a GitHub PAT with repo write access) to be set on the Railway
// service — without it, the file still exists on disk and is usable
// immediately, but is logged as at-risk of being lost on the next deploy.
// Best-effort throughout: any failure here must not fail whatever caller
// triggered it.
const fs = require('fs');
const path = require('path');

const GITHUB_OWNER = 'wertikooo-web';
const GITHUB_REPO = 'wine-ai';
const GITHUB_BRANCH = 'main';
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;

async function githubRequest(url, options, token) {
    const res = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'wine-ai-knowledge-bot',
            ...(options.headers || {}),
        },
    });
    return res;
}

async function putFile(repoRelativePath, content, message, token) {
    const url = `${GITHUB_API_BASE}/${repoRelativePath.split(path.sep).map(encodeURIComponent).join('/')}`;

    // Need the current file's blob SHA to update it (GitHub's API rejects
    // a PUT without `sha` if the file already exists) — a 404 here just
    // means this is a new file, which is fine.
    let existingSha;
    const getRes = await githubRequest(`${url}?ref=${GITHUB_BRANCH}`, { method: 'GET' }, token);
    if (getRes.ok) {
        const existing = await getRes.json();
        existingSha = existing.sha;
    } else if (getRes.status !== 404) {
        throw new Error(`GitHub GET ${repoRelativePath} failed: ${getRes.status} ${await getRes.text()}`);
    }

    const putRes = await githubRequest(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message,
            content: Buffer.from(content, 'utf8').toString('base64'),
            branch: GITHUB_BRANCH,
            ...(existingSha ? { sha: existingSha } : {}),
        }),
    }, token);

    if (!putRes.ok) {
        throw new Error(`GitHub PUT ${repoRelativePath} failed: ${putRes.status} ${await putRes.text()}`);
    }
}

async function commitKnowledgeFiles(repoRoot, absoluteFilePaths, commitMessage) {
    const paths = Array.isArray(absoluteFilePaths) ? absoluteFilePaths : [absoluteFilePaths];
    if (paths.length === 0) return;

    const token = process.env.GITHUB_PUSH_TOKEN;
    if (!token) {
        console.error('[knowledge persist] GITHUB_PUSH_TOKEN is not set — file(s) written to disk but will NOT survive the next deploy:', paths.join(', '));
        return;
    }

    for (const absolutePath of paths) {
        const repoRelativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
        try {
            const content = fs.readFileSync(absolutePath, 'utf8');
            await putFile(repoRelativePath, content, commitMessage, token);
        } catch (error) {
            console.error(`[knowledge persist] GitHub push failed for ${repoRelativePath} — will NOT survive the next deploy:`, error.message);
        }
    }
}

async function deleteKnowledgeFile(repoRoot, absoluteFilePath, commitMessage) {
    const token = process.env.GITHUB_PUSH_TOKEN;
    if (!token) {
        console.error('[knowledge persist] GITHUB_PUSH_TOKEN is not set — deleted locally but will reappear on the next deploy if it was ever pushed:', absoluteFilePath);
        return;
    }
    const repoRelativePath = path.relative(repoRoot, absoluteFilePath).split(path.sep).join('/');
    const url = `${GITHUB_API_BASE}/${repoRelativePath.split('/').map(encodeURIComponent).join('/')}`;
    try {
        const getRes = await githubRequest(`${url}?ref=${GITHUB_BRANCH}`, { method: 'GET' }, token);
        if (getRes.status === 404) return; // never made it to GitHub — nothing to delete there
        if (!getRes.ok) throw new Error(`GitHub GET ${repoRelativePath} failed: ${getRes.status} ${await getRes.text()}`);
        const existing = await getRes.json();

        const delRes = await githubRequest(url, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: commitMessage, sha: existing.sha, branch: GITHUB_BRANCH }),
        }, token);
        if (!delRes.ok) throw new Error(`GitHub DELETE ${repoRelativePath} failed: ${delRes.status} ${await delRes.text()}`);
    } catch (error) {
        console.error(`[knowledge persist] GitHub delete failed for ${repoRelativePath} — file may reappear on the next deploy:`, error.message);
    }
}

module.exports = { commitKnowledgeFiles, deleteKnowledgeFile };
