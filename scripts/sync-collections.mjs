#!/usr/bin/env node
import { readFile, writeFile, appendFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const PLAYLISTS = Object.freeze({
  song: { playlistId: 'PLJmCvCN8XgA8', title: '루메 노래' },
  asmr: { playlistId: 'PLc06btbrmeCw', title: '루메 ASMR' },
  aegyo: { playlistId: 'PLFK4yXX5LyZQ', title: '루메 애교송' },
});
export const PRIOR_URL = 'https://bbusiku.github.io/rumeyam/collections.json';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_PAGES = 100;
const MAX_TRACKS = 5000;
const REQUEST_TIMEOUT = 25000;
const MAX_RESPONSE_SIZE = 12 * 1024 * 1024;

class RetryablePlaylistError extends Error {}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => {
  if (typeof value === 'string') return value;
  if (!object(value)) return '';
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (typeof value.content === 'string') return value.content;
  return Array.isArray(value.runs) ? value.runs.map((run) => run?.text || '').join('') : '';
};

// This is a literal reader, not an evaluator. Page JavaScript is never executed.
export function readJavaScriptLiteral(source, start = 0) {
  let index = start;
  while (/\s/.test(source[index] || '') && index < source.length) index += 1;
  const first = source[index];
  if (first === '"' || first === "'") {
    const quote = first;
    let value = '';
    index += 1;
    while (index < source.length) {
      const char = source[index++];
      if (char === quote) return { value, end: index };
      if (char === '\n' || char === '\r') throw new Error('Unescaped newline in page data.');
      if (char !== '\\') { value += char; continue; }
      if (index >= source.length) throw new Error('Truncated page string.');
      const escaped = source[index++];
      if (escaped === '\n') continue;
      if (escaped === '\r') { if (source[index] === '\n') index += 1; continue; }
      if (escaped === 'x' || escaped === 'u') {
        const size = escaped === 'x' ? 2 : 4;
        const hex = source.slice(index, index + size);
        if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) throw new Error('Invalid page string escape.');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += size;
        continue;
      }
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'", '/': '/' };
      if (!(escaped in escapes)) throw new Error('Unsupported page string escape.');
      value += escapes[escaped];
    }
    throw new Error('Unterminated page string.');
  }
  if (first !== '{' && first !== '[') throw new Error('Expected JSON page data.');
  const stack = [];
  let quoted = false;
  let escaped = false;
  const begin = index;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') {
      const open = stack.pop();
      if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) throw new Error('Unbalanced page JSON.');
      if (!stack.length) return { value: JSON.parse(source.slice(begin, index + 1)), end: index + 1 };
    }
  }
  throw new Error('Truncated page JSON.');
}

export function extractInitialData(html) {
  if (typeof html !== 'string' || html.length > MAX_RESPONSE_SIZE) throw new Error('Invalid playlist page size.');
  const assignments = /(?:\b(?:var\s+)?ytInitialData|window\s*\[\s*['"]ytInitialData['"]\s*\])\s*=\s*/g;
  const errors = [];
  for (const match of html.matchAll(assignments)) {
    try {
      const literal = readJavaScriptLiteral(html, match.index + match[0].length);
      const value = typeof literal.value === 'string' ? JSON.parse(literal.value) : literal.value;
      if (object(value)) return value;
    } catch (error) { errors.push(error.message); }
  }
  if (/confirm (?:that )?you.?re not a bot|unusual traffic|unusual requests|로봇이 아님|비정상적인 트래픽/i.test(html)) {
    throw new Error('YouTube returned a bot or traffic challenge.');
  }
  throw new RetryablePlaylistError(errors.length ? 'Malformed ytInitialData in playlist page.' : 'Playlist page has no readable ytInitialData.');
}

export function extractClientContext(html) {
  const config = {};
  for (const match of html.matchAll(/\bytcfg\.set\s*\(\s*/g)) {
    try {
      const { value } = readJavaScriptLiteral(html, match.index + match[0].length);
      if (object(value)) Object.assign(config, value);
    } catch { /* Other script calls need not be JSON configuration. */ }
  }
  const published = config.INNERTUBE_CONTEXT?.client || {};
  const clientName = published.clientName;
  const clientVersion = published.clientVersion || config.INNERTUBE_CONTEXT_CLIENT_VERSION || config.INNERTUBE_CLIENT_VERSION;
  if (typeof clientName !== 'string' || !/^[A-Z0-9_]{1,40}$/.test(clientName) ||
      typeof clientVersion !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(clientVersion)) {
    throw new Error('Playlist continuation has no valid public client context.');
  }
  // Only public client identification is needed: no API key, cookie, visitor token,
  // account information, remote address, or authorization is forwarded.
  const client = { clientName, clientVersion, hl: 'ko' };
  if (typeof published.gl === 'string' && /^[A-Z]{2}$/.test(published.gl)) client.gl = published.gl;
  const numericName = config.INNERTUBE_CONTEXT_CLIENT_NAME;
  return { context: { client }, numericName: Number.isInteger(numericName) && numericName > 0 ? numericName : null };
}

function visit(value, callback) {
  if (Array.isArray(value)) { for (const child of value) visit(child, callback); return; }
  if (!object(value)) return;
  if (callback(value) === false) return;
  for (const child of Object.values(value)) visit(child, callback);
}

function assertResponse(data) {
  if (!object(data)) throw new Error('YouTube returned malformed playlist data.');
  if (data.error) throw new Error('YouTube rejected the playlist request.');
  visit(data.alerts, (value) => {
    const alert = value.alertRenderer || value.alertWithButtonRenderer;
    // INFO can report hidden private/deleted videos while the playlist is valid.
    // Missing content and empty public lists are validated separately below.
    if (alert?.type === 'ERROR') {
      throw new Error('The playlist is private, unavailable, or rejected by YouTube.');
    }
  });
}

function canonicalTrack(id, title, artist) {
  if (typeof id !== 'string' || !VIDEO_ID.test(id) || typeof title !== 'string' || !title.trim() || title.length > 300 ||
      typeof artist !== 'string' || !artist.trim() || artist.length > 150) throw new Error('Malformed playlist video metadata.');
  return { id, title, artist, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, favorite: false };
}

function unavailableVideo(renderer) {
  return !!renderer && (renderer.isPlayable === false || /^\[?(?:private video|deleted video|비공개 동영상|삭제된 동영상)\]?$/i.test(text(renderer.title).trim()));
}

function trackFromRenderer(value, playlistId) {
  const legacy = value.playlistVideoRenderer;
  if (legacy) {
    const endpoint = legacy.navigationEndpoint?.watchEndpoint;
    if (endpoint?.playlistId && endpoint.playlistId !== playlistId) return null;
    if (unavailableVideo(legacy)) return null;
    const title = text(legacy.title);
    return canonicalTrack(legacy.videoId, title, text(legacy.shortBylineText || legacy.longBylineText || legacy.ownerText) || 'YouTube');
  }
  const modern = value.lockupViewModel;
  if (!modern) return null;
  const endpoint = modern.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
  if (!endpoint || endpoint.playlistId !== playlistId || (modern.contentType && modern.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO')) return null;
  const metadata = modern.metadata?.lockupMetadataViewModel;
  const artist = text(metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text) || 'YouTube';
  return canonicalTrack(endpoint.videoId, text(metadata?.title), artist);
}

function initialRoot(data) {
  const browse = data.contents?.twoColumnBrowseResultsRenderer || data.contents?.singleColumnBrowseResultsRenderer;
  const tabs = browse?.tabs?.map((tab) => tab.tabRenderer).filter(Boolean) || [];
  const selected = tabs.find((tab) => tab.selected && tab.content) || tabs.find((tab) => tab.content);
  if (selected) return selected.content;
  if (data.contents?.playlistVideoListRenderer) return data.contents;
  throw new Error('Playlist page has no recognized playlist content.');
}

function continuationRoots(data) {
  const roots = [];
  for (const action of [...(data.onResponseReceivedActions || []), ...(data.onResponseReceivedEndpoints || [])]) {
    const list = action.appendContinuationItemsAction || action.reloadContinuationItemsCommand;
    if (Array.isArray(list?.continuationItems)) roots.push(list.continuationItems);
  }
  const continued = data.continuationContents?.playlistVideoListContinuation || data.continuationContents?.sectionListContinuation || data.continuationContents?.itemSectionContinuation;
  if (continued) roots.push(continued);
  if (!roots.length) throw new Error('Unrecognized playlist continuation response.');
  return roots;
}

export function parsePlaylistData(data, playlistId, { continuation = false } = {}) {
  assertResponse(data);
  const root = continuation ? continuationRoots(data) : initialRoot(data);
  const tracks = [];
  const tokens = new Set();
  let emptyList = false;
  visit(root, (value) => {
    if (value.playlistVideoListRenderer?.playlistId && value.playlistVideoListRenderer.playlistId !== playlistId) {
      throw new Error('YouTube returned the wrong playlist.');
    }
    const list = value.playlistVideoListRenderer;
    if (list?.playlistId === playlistId && Array.isArray(list.contents) &&
        list.contents.every((item) => unavailableVideo(item?.playlistVideoRenderer))) {
      emptyList = true;
    }
    if (value.playlistVideoRenderer || value.lockupViewModel) {
      const track = trackFromRenderer(value, playlistId);
      if (track) tracks.push(track);
      return false;
    }
    const token = value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
      value.nextContinuationData?.continuation || value.reloadContinuationData?.continuation;
    if (token !== undefined) {
      if (typeof token !== 'string' || !token || token.length > 20000) throw new Error('Malformed continuation token.');
      tokens.add(token);
      return false;
    }
  });
  if (tokens.size > 1) throw new Error('Ambiguous playlist pagination; refusing to publish a partial catalog.');
  const title = text(data.metadata?.playlistMetadataRenderer?.title) || text(data.header?.pageHeaderRenderer?.pageTitle) ||
    text(data.header?.playlistHeaderRenderer?.title);
  return { tracks, continuation: [...tokens][0] || null, title, emptyList };
}

async function responseText(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT) }); }
  catch (error) { throw new RetryablePlaylistError(`Request could not complete: ${error.message}`, { cause: error }); }
  if (!response.ok) {
    const ErrorType = [408, 429].includes(response.status) || response.status >= 500 ? RetryablePlaylistError : Error;
    throw new ErrorType(`Request failed with HTTP ${response.status}.`);
  }
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_SIZE) throw new Error('Response is too large.');
  let body;
  try { body = await response.text(); }
  catch (error) { throw new RetryablePlaylistError(`Response could not complete: ${error.message}`, { cause: error }); }
  if (body.length > MAX_RESPONSE_SIZE) throw new Error('Response is too large.');
  return body;
}

export async function fetchPlaylist(key, { fetchImpl = fetch, maxPages = MAX_PAGES } = {}) {
  const config = PLAYLISTS[key];
  if (!config) throw new Error('Unknown collection key.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new Error('Invalid page limit.');
  const html = await responseText(fetchImpl, `https://www.youtube.com/playlist?list=${config.playlistId}`, {
    headers: { Accept: 'text/html', 'Accept-Language': 'ko,en;q=0.8' },
  });
  const first = parsePlaylistData(extractInitialData(html), config.playlistId);
  if (!first.title || first.title.length > 300) throw new Error('Playlist title is missing or malformed.');
  const tracks = new Map();
  const add = (entries) => {
    for (const track of entries) if (!tracks.has(track.id)) tracks.set(track.id, track);
    if (tracks.size > MAX_TRACKS) throw new Error('Playlist exceeds the safety limit; no partial catalog will be published.');
  };
  add(first.tracks);
  let token = first.continuation;
  const tokens = new Set();
  let pages = 1;
  const client = token ? extractClientContext(html) : null;
  while (token) {
    if (tokens.has(token)) throw new Error('YouTube repeated a continuation token.');
    if (pages >= maxPages) throw new Error('Playlist pagination exceeded the page limit; refusing truncation.');
    tokens.add(token);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-YouTube-Client-Version': client.context.client.clientVersion };
    if (client.numericName) headers['X-YouTube-Client-Name'] = String(client.numericName);
    const body = await responseText(fetchImpl, 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST', headers, body: JSON.stringify({ context: client.context, continuation: token }),
    });
    let data;
    try { data = JSON.parse(body.replace(/^\)\]\}'\s*\n?/, '')); }
    catch { throw new RetryablePlaylistError('YouTube continuation returned invalid JSON.'); }
    const page = parsePlaylistData(data, config.playlistId, { continuation: true });
    add(page.tracks);
    token = page.continuation;
    pages += 1;
  }
  if (!tracks.size && !first.emptyList) throw new Error('Playlist has no recognized public video list; keeping the previous catalog.');
  return { playlistId: config.playlistId, title: first.title, tracks: [...tracks.values()] };
}

export async function fetchPlaylistWithRetry(key, { attempts = 3, sleepImpl = delay, log = console.error, ...options } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('Invalid retry limit.');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await fetchPlaylist(key, options); }
    catch (error) {
      if (!(error instanceof RetryablePlaylistError) || attempt === attempts) throw error;
      log(`Retrying ${key} (${attempt + 1}/${attempts}): ${error.message}`);
      // Restart the entire playlist so a failed continuation never publishes a partial list.
      await sleepImpl(1000 * 2 ** (attempt - 1));
    }
  }
}

export function validateManifest(value, { allowMissing = false } = {}) {
  if (!object(value) || value.version !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      !object(value.collections)) throw new Error('Invalid collections manifest.');
  const collections = {};
  for (const [key, expected] of Object.entries(PLAYLISTS)) {
    // Only prior deployments may omit newly introduced categories.
    if (allowMissing && !Object.hasOwn(value.collections, key)) continue;
    const collection = value.collections[key];
    if (!object(collection) || collection.playlistId !== expected.playlistId || typeof collection.title !== 'string' ||
        !collection.title.trim() || collection.title.length > 300 || !Array.isArray(collection.tracks) ||
        collection.tracks.length > MAX_TRACKS) throw new Error(`Invalid ${key} catalog in manifest.`);
    const seen = new Set();
    const tracks = collection.tracks.map((track) => {
      if (!object(track)) throw new Error('Invalid track in manifest.');
      const clean = canonicalTrack(track.id, track.title, track.artist);
      if (seen.has(clean.id) || track.favorite !== false || track.thumbnail !== clean.thumbnail) throw new Error('Noncanonical or duplicate manifest track.');
      seen.add(clean.id);
      return clean;
    });
    collections[key] = { playlistId: expected.playlistId, title: collection.title, tracks };
  }
  return { version: 1, updatedAt: new Date(value.updatedAt).toISOString(), collections };
}

export async function synchronize({ previous = null, strict = false, scheduled = false, fetchImpl = fetch, now = new Date(), retryOptions = {} } = {}) {
  const lastGood = previous ? validateManifest(previous) : null;
  const keys = Object.keys(PLAYLISTS);
  const results = await Promise.allSettled(keys.map((key) => fetchPlaylistWithRetry(key, { ...retryOptions, fetchImpl })));
  const collections = {};
  const refreshed = [];
  const failures = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const result = results[i];
    if (result.status === 'fulfilled') { collections[key] = result.value; refreshed.push(key); }
    else {
      failures.push({ key, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      if (lastGood) collections[key] = lastGood.collections[key];
    }
  }
  if (failures.length && strict) {
    throw new Error(`Catalog refresh failed; output was not changed. ${failures.map(({ key, message }) => `${key}: ${message}`).join(' ')}`);
  }
  // A scheduled refresh must never redeploy older checkout seeds or partial data.
  // Leave the current Pages deployment intact and try again at the next schedule.
  if (failures.length && scheduled) {
    return { manifest: lastGood, refreshed: [], failures, unchanged: true, publish: false };
  }
  if (failures.length && !lastGood) {
    throw new Error(`Catalog refresh failed; output was not changed. ${failures.map(({ key, message }) => `${key}: ${message}`).join(' ')}`);
  }
  const manifest = refreshed.length ? validateManifest({ version: 1, updatedAt: new Date(now).toISOString(), collections }) : lastGood;
  return { manifest, refreshed, failures, unchanged: refreshed.length === 0, publish: true };
}

export async function writeManifestAtomic(output, manifest) {
  const validated = validateManifest(manifest);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, output);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function readPrevious(output, { fetchImpl = fetch, log = console.error } = {}) {
  let local = null;
  let published = null;
  try { local = validateManifest(JSON.parse(await readFile(output, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') log(`Local catalog was ignored: ${error.message}`); }
  try {
    published = validateManifest(JSON.parse(await responseText(fetchImpl, PRIOR_URL, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } })), { allowMissing: true });
  } catch (error) { log(`Published catalog unavailable; local seeds or last-good data will be used if needed. ${error.message}`); }
  if (!published) return local;
  if (Object.keys(published.collections).length !== Object.keys(PLAYLISTS).length) {
    if (!local) return null;
    // Keep published categories (including empty lists); seed only missing ones.
    return validateManifest({ ...published, collections: { ...local.collections, ...published.collections } });
  }
  if (!local) return published;
  return Date.parse(published.updatedAt) >= Date.parse(local.updatedAt) ? published : local;
}

export async function main(args = process.argv.slice(2)) {
  let output = resolve('public/collections.json');
  let strict = process.env.SYNC_STRICT === 'true';
  let scheduled = process.env.SYNC_SCHEDULED === 'true';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--strict') strict = true;
    else if (args[i] === '--scheduled') scheduled = true;
    else if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) output = resolve(args[++i]);
    else if (args[i] === '--help') {
      console.log('Usage: node scripts/sync-collections.mjs [--strict] [--scheduled] [--output public/collections.json]\nStrict mode (--strict or SYNC_STRICT=true) requires all playlists to refresh before writing. Scheduled mode (--scheduled or SYNC_SCHEDULED=true) skips publication on refresh failures. Normal mode preserves last-good categories on partial failures.');
      return;
    } else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  const previous = await readPrevious(output);
  const result = await synchronize({ previous, strict, scheduled });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${result.publish}\n`);
  if (!result.publish) {
    for (const failure of result.failures) {
      const message = `Scheduled refresh deferred; the live site is unchanged. ${failure.key}: ${failure.message}`;
      const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      console.error(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${escaped}` : message);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, 'Playlist refresh was deferred after an upstream error. The current site and its published catalog were kept unchanged. The next hourly run will try again; see the refresh warnings for details.\n');
    }
    return;
  }
  for (const key of result.refreshed) console.log(`Fetched live ${key}: ${result.manifest.collections[key].tracks.length} videos from https://www.youtube.com/playlist?list=${PLAYLISTS[key].playlistId}`);
  for (const failure of result.failures) console.error(`Keeping last-good ${failure.key}: ${failure.message}`);
  await writeManifestAtomic(output, result.manifest);
  console.log(`${result.unchanged ? 'Retained' : 'Updated'} ${output}: ${Object.entries(result.manifest.collections).map(([key, value]) => `${key} ${value.tracks.length}`).join(', ')}. Refreshed: ${result.refreshed.join(', ') || 'none'}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
