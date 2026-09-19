import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import {
  PLAYLISTS, extractInitialData, extractClientContext, parsePlaylistData,
  fetchPlaylist, fetchPlaylistWithRetry, validateManifest, synchronize, writeManifestAtomic, readPrevious, main,
} from '../scripts/sync-collections.mjs';

const id = (n) => `v${String(n).padStart(10, '0')}`;
const legacy = (n, key = 'song') => ({ playlistVideoRenderer: {
  videoId: id(n), title: { runs: [{ text: `곡 ${n} "quoted" \\ path` }] },
  shortBylineText: { runs: [{ text: '카루메' }] },
  navigationEndpoint: { watchEndpoint: { playlistId: PLAYLISTS[key].playlistId } },
} });
const token = (value) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: value } } } });
const data = (entries, key = 'song') => ({
  metadata: { playlistMetadataRenderer: { title: PLAYLISTS[key].title } },
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: {
    sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: {
      playlistId: PLAYLISTS[key].playlistId, contents: entries,
    } }] } }] },
  } } }] } },
});
const clientConfig = {
  INNERTUBE_CONTEXT_CLIENT_NAME: 1,
  INNERTUBE_API_KEY: 'must-not-forward',
  INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20260909.00.00', gl: 'KR', visitorData: 'must-not-forward', remoteHost: 'must-not-forward' }, user: { token: 'must-not-forward' } },
};
const html = (value) => `<script>ytcfg.set(${JSON.stringify(clientConfig)});var ytInitialData = ${JSON.stringify(value)};</script>`;
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const retryOptions = { sleepImpl: async () => {}, log: () => {} };
const categoryFor = (url) => Object.keys(PLAYLISTS).find((key) => url.includes(PLAYLISTS[key].playlistId));
const refreshReply = (url, song) => {
  const key = categoryFor(url);
  return reply(html(key === 'song' ? song : data([legacy(4, key)], key)));
};
const manifest = () => ({ version: 1, updatedAt: '2026-09-09T00:00:00.000Z', collections: Object.fromEntries(
  Object.keys(PLAYLISTS).map((key, index) => [key, { ...PLAYLISTS[key], tracks: [{
    id: id(index + 1), title: `Saved ${key}`, artist: '카루메', thumbnail: `https://i.ytimg.com/vi/${id(index + 1)}/mqdefault.jpg`, favorite: false,
  }] }]),
) });

test('parses JSON assignments without losing quoted text or reading inactive tabs', () => {
  const value = data([legacy(1)]);
  value.contents.twoColumnBrowseResultsRenderer.tabs.unshift({ tabRenderer: { content: { playlistVideoListRenderer: { playlistId: 'unrelated', contents: [legacy(99)] } } } });
  const extracted = extractInitialData(html(value));
  const parsed = parsePlaylistData(extracted, PLAYLISTS.song.playlistId);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].title, '곡 1 "quoted" \\ path');
  assert.equal(parsed.tracks[0].favorite, false);
});

test('decodes escaped JavaScript string data, including nested JSON escapes and Unicode', () => {
  const value = data([legacy(1)]);
  value.metadata.playlistMetadataRenderer.title = "루메 It's Me 💛";
  const encoded = JSON.stringify(value).split('').map((char) => {
    const n = char.charCodeAt(0);
    return n < 128 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
  }).join('');
  assert.deepEqual(extractInitialData(`<script>var ytInitialData = '${encoded}';</script>`), value);
  const mixed = JSON.stringify(value).split('').map((char) => {
    if (char === '\\') return '\\\\';
    if ('\"\'{}[]'.includes(char)) return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
    return char;
  }).join('');
  // Real pages combine ordinary backslash escapes with hexadecimal quote escapes.
  assert.deepEqual(extractInitialData(`<script>window['ytInitialData'] = '${mixed}';</script>`), value);
});

test('literal parser rejects executable expressions and malformed/bot/private pages', () => {
  globalThis.__playlistParserExecuted = false;
  assert.throws(() => extractInitialData('<script>var ytInitialData = (() => { globalThis.__playlistParserExecuted = true; return {}; })();</script>'), /Malformed/);
  assert.equal(globalThis.__playlistParserExecuted, false);
  delete globalThis.__playlistParserExecuted;
  assert.throws(() => extractInitialData("<html>Sign in to confirm you're not a bot</html>"), /bot/);
  assert.throws(() => extractInitialData('var ytInitialData = {"broken":'), /Malformed/);
  assert.throws(() => parsePlaylistData({ alerts: [{ alertRenderer: { type: 'ERROR', text: { simpleText: 'This playlist is private' } } }] }, PLAYLISTS.song.playlistId), /private/);
});

test('modern mobile lockups include only videos belonging to the requested playlist', () => {
  const lockup = (n, list) => ({ lockupViewModel: {
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: { title: { content: `ASMR ${n}` }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: '카루메 𝐀𝐒𝐌𝐑' } }] }] } } } },
    rendererContext: { commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: id(n), playlistId: list } } } } },
  } });
  const value = { header: { pageHeaderRenderer: { pageTitle: '루메 ASMR' } }, contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [lockup(1, PLAYLISTS.asmr.playlistId), lockup(2, 'unrelated')] } }] } } } }] } } };
  const parsed = parsePlaylistData(value, PLAYLISTS.asmr.playlistId);
  assert.equal(parsed.title, '루메 ASMR');
  assert.deepEqual(parsed.tracks.map((track) => track.id), [id(1)]);
});

test('hidden unavailable-video INFO alerts do not stop strict scheduled refreshes', async () => {
  for (const message of ['사용할 수 없는 동영상 1개가 숨겨졌습니다.', '1 unavailable video is hidden.']) {
    const song = data([legacy(1), { playlistVideoRenderer: { isPlayable: false, title: { simpleText: '[Private video]' } } }, legacy(3)]);
    song.alerts = [{ alertWithButtonRenderer: { type: 'INFO', text: { simpleText: message } } }];
    const result = await synchronize({ strict: true, fetchImpl: async (url) => refreshReply(url, song) });
    assert.deepEqual(result.refreshed, Object.keys(PLAYLISTS));
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.manifest.collections.song.tracks.map((track) => track.id), [id(1), id(3)]);
  }
});

test('fatal playlist errors and missing content still fail even when alert wording changes', () => {
  const fatal = data([legacy(1)]);
  fatal.alerts = [{ alertWithButtonRenderer: { type: 'ERROR', text: { simpleText: 'Try again later.' } } }];
  assert.throws(() => parsePlaylistData(fatal, PLAYLISTS.song.playlistId), /rejected/);
  assert.throws(() => parsePlaylistData({ alerts: [{ alertRenderer: { type: 'INFO', text: { simpleText: 'Unavailable playlist' } } }] }, PLAYLISTS.song.playlistId), /no recognized playlist content/);
});

test('continues beyond 100 entries in order without duplicate IDs or credential forwarding', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return reply(html(data([...Array.from({ length: 100 }, (_, n) => legacy(n)), token('NEXT')])));
    return reply({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [legacy(99), ...Array.from({ length: 31 }, (_, n) => legacy(n + 100))] } }] });
  };
  const collection = await fetchPlaylist('song', { fetchImpl });
  assert.equal(collection.tracks.length, 131);
  assert.deepEqual(collection.tracks.map((track) => track.id), Array.from({ length: 131 }, (_, n) => id(n)));
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { context: { client: { clientName: 'WEB', clientVersion: '2.20260909.00.00', hl: 'ko', gl: 'KR' } }, continuation: 'NEXT' });
  assert.doesNotMatch(JSON.stringify(requests[1]), /must-not-forward|Authorization|Cookie|[?&]key=/i);
});

test('legacy continuationContents pagination works, including final pages', async () => {
  let calls = 0;
  const result = await fetchPlaylist('song', { fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return reply(html(data([legacy(1), token('ONE')])));
    if (calls === 2) return reply({ continuationContents: { playlistVideoListContinuation: { contents: [legacy(2)], continuations: [{ nextContinuationData: { continuation: 'TWO' } }] } } });
    return reply({ continuationContents: { playlistVideoListContinuation: { contents: [legacy(3)] } } });
  } });
  assert.deepEqual(result.tracks.map((track) => track.id), [id(1), id(2), id(3)]);
  assert.equal(calls, 3);
});

test('pagination loops, unknown shapes, ambiguous tokens, and limits fail instead of truncating', async () => {
  let calls = 0;
  await assert.rejects(fetchPlaylist('song', { fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? reply(html(data([legacy(1), token('LOOP')]))) : reply({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [legacy(2), token('LOOP')] } }] });
  } }), /repeated/);
  await assert.rejects(fetchPlaylist('song', { maxPages: 1, fetchImpl: async () => reply(html(data([legacy(1), token('MORE')]))) }), /page limit/);
  assert.throws(() => parsePlaylistData({ unexpected: [] }, PLAYLISTS.song.playlistId, { continuation: true }), /Unrecognized/);
  assert.throws(() => parsePlaylistData(data([legacy(1), token('A'), token('B')]), PLAYLISTS.song.playlistId), /Ambiguous/);
  assert.throws(() => extractClientContext('ytcfg.set({"INNERTUBE_API_KEY":"not-a-context"});'), /context/);
});

test('normal refresh preserves the previous failed category; strict refresh rejects without mutating it', async () => {
  const previous = manifest();
  const untouched = structuredClone(previous);
  const fetchImpl = async (url) => url.includes(PLAYLISTS.song.playlistId) ? reply(html(data([legacy(8)]))) : reply('Unavailable', 503);
  const normal = await synchronize({ previous, fetchImpl, retryOptions, now: '2026-09-10T00:00:00Z' });
  assert.deepEqual(normal.refreshed, ['song']);
  assert.deepEqual(normal.manifest.collections.asmr, previous.collections.asmr);
  assert.deepEqual(normal.manifest.collections.aegyo, previous.collections.aegyo);
  assert.equal(normal.manifest.collections.song.tracks[0].id, id(8));
  assert.equal(normal.failures[0].key, 'asmr');
  await assert.rejects(synchronize({ previous, fetchImpl, retryOptions, strict: true }), /output was not changed/);
  await assert.rejects(synchronize({ fetchImpl, retryOptions }), /output was not changed/);
  assert.deepEqual(previous, untouched);
});

test('complete fetch failure retains the last-good manifest and timestamp', async () => {
  const previous = manifest();
  const result = await synchronize({ previous, retryOptions, fetchImpl: async () => { throw new Error('network unavailable'); } });
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.manifest, previous);
});

test('playlist refresh retries malformed or missing initial data, network failures, and transient HTTP errors', async () => {
  const transient = [
    () => reply('<script>var ytInitialData = {"broken":</script>'),
    () => reply('<html>Temporary playlist response</html>'),
    () => { throw new TypeError('fetch failed'); },
    ...[408, 429, 500, 503].map((status) => () => reply('Try again later', status)),
  ];
  for (const fail of transient) {
    let calls = 0;
    const delays = [];
    const result = await fetchPlaylistWithRetry('song', {
      ...retryOptions,
      sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
      fetchImpl: async () => ++calls === 1 ? fail() : reply(html(data([legacy(7), legacy(8)]))),
    });
    assert.equal(calls, 2);
    assert.equal(delays.length, 1);
    assert.ok(Number.isFinite(delays[0]) && delays[0] > 0);
    assert.deepEqual(result.tracks.map((track) => track.id), [id(7), id(8)]);
  }
});

test('persistent malformed initial data exhausts three attempts without unbounded retries', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(fetchPlaylistWithRetry('song', {
    ...retryOptions,
    sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      calls += 1;
      return reply('<script>var ytInitialData = {"broken":</script>');
    },
  }), /Malformed ytInitialData/);
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test('permanent HTTP errors, unavailable playlists, and wrong playlist identities are not retried', async () => {
  const privatePlaylist = data([legacy(1)]);
  privatePlaylist.alerts = [{ alertRenderer: { type: 'ERROR', text: { simpleText: 'Private playlist' } } }];
  const permanent = [
    { body: () => reply('Not found', 404), error: /HTTP 404/ },
    { body: () => reply(html(privatePlaylist)), error: /private|rejected/ },
    { body: () => reply(html(data([legacy(1, 'asmr')], 'asmr'))), error: /wrong playlist/ },
  ];
  for (const { body, error } of permanent) {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(fetchPlaylistWithRetry('song', {
      ...retryOptions,
      sleepImpl: async () => { sleeps += 1; },
      fetchImpl: async () => { calls += 1; return body(); },
    }), error);
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test('a malformed continuation restarts the full playlist without retaining stale partial tracks', async () => {
  const requests = [];
  const result = await fetchPlaylistWithRetry('song', {
    ...retryOptions,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) return reply(html(data([legacy(1), token('OLD')])));
      if (requests.length === 2) return reply('{"broken":');
      if (requests.length === 3) return reply(html(data([legacy(3), legacy(4), token('NEW')])));
      return reply({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [legacy(4), legacy(5)] } }] });
    },
  });
  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, requests[2].url);
  assert.equal(JSON.parse(requests[1].options.body).continuation, 'OLD');
  assert.equal(JSON.parse(requests[3].options.body).continuation, 'NEW');
  assert.deepEqual(result.tracks.map((track) => track.id), [id(3), id(4), id(5)]);
});

test('scheduled partial failures skip publication and retain the complete previous catalog and timestamp', async () => {
  const previous = manifest();
  const untouched = structuredClone(previous);
  const calls = { song: 0, asmr: 0, aegyo: 0 };
  const result = await synchronize({
    previous, scheduled: true, retryOptions, now: '2026-09-19T00:00:00Z',
    fetchImpl: async (url) => {
      const key = categoryFor(url);
      calls[key] += 1;
      return key === 'aegyo' ? reply('<script>var ytInitialData = {"broken":</script>') : reply(html(data([legacy(9, key)], key)));
    },
  });
  assert.equal(result.publish, false);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(result.failures.map(({ key }) => key), ['aegyo']);
  assert.deepEqual(result.manifest, untouched);
  assert.deepEqual(previous, untouched);
  assert.deepEqual(calls, { song: 1, asmr: 1, aegyo: 3 });
});

test('scheduled failures also skip publication when no valid previous catalog exists', async () => {
  const result = await synchronize({
    scheduled: true, retryOptions,
    fetchImpl: async (url) => categoryFor(url) === 'song' ? reply('Unavailable', 503) : reply(html(data([legacy(9, categoryFor(url))], categoryFor(url)))),
  });
  assert.equal(result.publish, false);
  assert.equal(result.manifest, null);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.refreshed, []);
  assert.deepEqual(result.failures.map(({ key }) => key), ['song']);
});

test('successful scheduled refreshes publish every collection together', async () => {
  const result = await synchronize({
    scheduled: true, retryOptions, now: '2026-09-19T00:00:00Z',
    fetchImpl: async (url) => {
      const key = categoryFor(url);
      return reply(html(data([legacy(9, key)], key)));
    },
  });
  assert.equal(result.publish, true);
  assert.equal(result.unchanged, false);
  assert.deepEqual(result.refreshed, Object.keys(PLAYLISTS));
  assert.deepEqual(result.failures, []);
  assert.equal(result.manifest.updatedAt, '2026-09-19T00:00:00.000Z');
  for (const key of Object.keys(PLAYLISTS)) assert.deepEqual(result.manifest.collections[key].tracks.map((track) => track.id), [id(9)]);
});

test('explicit strict mode still rejects failed scheduled refreshes', async () => {
  await assert.rejects(synchronize({
    previous: manifest(), scheduled: true, strict: true, retryOptions,
    fetchImpl: async () => reply('Unavailable', 503),
  }), /output was not changed/);
});

test('scheduled CLI publishes its decision and never overwrites or creates a catalog after refresh failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'karume-catalog-test-'));
  const environmentKeys = ['SYNC_STRICT', 'SYNC_SCHEDULED', 'GITHUB_ACTIONS', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'];
  const environment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const warnings = [];
  t.mock.method(console, 'error', (message) => { warnings.push(message); });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const key = categoryFor(url);
    return !key || key === 'song' ? reply('Not found', 404) : reply(html(data([legacy(9, key)], key)));
  });
  try {
    delete process.env.SYNC_STRICT;
    delete process.env.SYNC_SCHEDULED;
    process.env.GITHUB_ACTIONS = 'true';
    for (const hasPrevious of [true, false]) {
      const output = join(directory, `${hasPrevious ? 'existing' : 'missing'}.json`);
      process.env.GITHUB_OUTPUT = join(directory, `${hasPrevious}-github-output`);
      process.env.GITHUB_STEP_SUMMARY = join(directory, `${hasPrevious}-summary`);
      const original = `${JSON.stringify(manifest())}\n`;
      if (hasPrevious) await writeFile(output, original);
      await main(['--scheduled', '--output', output]);
      assert.equal(await readFile(process.env.GITHUB_OUTPUT, 'utf8'), 'publish=false\n');
      assert.match(await readFile(process.env.GITHUB_STEP_SUMMARY, 'utf8'), /kept unchanged/);
      if (hasPrevious) assert.equal(await readFile(output, 'utf8'), original);
      else await assert.rejects(readFile(output, 'utf8'), { code: 'ENOENT' });
    }
    assert.equal(warnings.filter((message) => message.startsWith('::warning::')).length, 2);
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('karume-catalog-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown, unrelated, malformed video data and invalid manifests cannot replace catalogs', async () => {
  await assert.rejects(fetchPlaylist('song', { fetchImpl: async () => reply(html(data([{ unknownVideoRenderer: {} }]))) }), /no recognized/);
  await assert.rejects(fetchPlaylist('song', { fetchImpl: async () => reply(html(data([legacy(1)], 'asmr'))) }), /wrong playlist/);
  const broken = data([legacy(1)]);
  broken.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].playlistVideoListRenderer.contents[0].playlistVideoRenderer.videoId = 'bad-id';
  assert.throws(() => parsePlaylistData(broken, PLAYLISTS.song.playlistId), /Malformed/);
  const value = manifest();
  value.collections.song.tracks.push(value.collections.song.tracks[0]);
  assert.throws(() => validateManifest(value), /duplicate/);
  value.collections.song.tracks.pop();
  value.collections.song.tracks[0].thumbnail = 'https://unrelated.invalid/tracker';
  assert.throws(() => validateManifest(value), /Noncanonical/);
});

test('deleting every video publishes a verified empty playlist instead of restoring old songs', async () => {
  for (const entries of [[], [{ playlistVideoRenderer: { isPlayable: false } }], [{ playlistVideoRenderer: { title: { simpleText: '[Deleted video]' } } }, { playlistVideoRenderer: { title: { simpleText: '[Private video]' } } }]]) {
    const song = data(entries);
    song.alerts = [{ alertWithButtonRenderer: { type: 'INFO', text: { simpleText: 'Unavailable videos are hidden' } } }];
    const result = await synchronize({ previous: manifest(), strict: true, fetchImpl: async (url) => refreshReply(url, song) });
    assert.deepEqual(result.refreshed, Object.keys(PLAYLISTS));
    assert.deepEqual(result.manifest.collections.song.tracks, []);
    assert.deepEqual(validateManifest(result.manifest).collections.song.tracks, []);
  }
});

test('an empty list without matching playlist identity cannot erase a saved collection', async () => {
  const unverified = data([]);
  delete unverified.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].playlistVideoListRenderer.playlistId;
  await assert.rejects(fetchPlaylist('song', { fetchImpl: async () => reply(html(unverified)) }), /no recognized/);
});

test('atomic write validates first; prior published catalog wins over older local seeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'karume-catalog-test-'));
  try {
    const output = join(directory, 'collections.json');
    const local = manifest();
    await writeManifestAtomic(output, local);
    const initialBytes = await readFile(output, 'utf8');
    await assert.rejects(writeManifestAtomic(output, { version: 9 }), /Invalid/);
    assert.equal(await readFile(output, 'utf8'), initialBytes);
    const published = structuredClone(local);
    published.updatedAt = '2026-09-10T00:00:00.000Z';
    published.collections.asmr.tracks[0].title = 'Published newer title';
    const result = await readPrevious(output, { fetchImpl: async () => reply(published), log: () => {} });
    assert.deepEqual(result, published);
    await writeFile(output, '{broken');
    assert.deepEqual(await readPrevious(output, { fetchImpl: async () => reply(published), log: () => {} }), published);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('karume-catalog-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new category preserves published Song/ASMR and fills only its missing seed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'karume-catalog-test-'));
  try {
    const output = join(directory, 'collections.json');
    const seed = manifest();
    seed.updatedAt = '2026-09-10T12:00:00.000Z';
    await writeManifestAtomic(output, seed);
    const published = manifest();
    delete published.collections.aegyo;
    published.collections.song.tracks = [];
    published.collections.asmr.tracks[0].title = 'Latest published ASMR';
    assert.throws(() => validateManifest(published), /aegyo/);
    const merged = await readPrevious(output, { fetchImpl: async () => reply(published), log: () => {} });
    assert.deepEqual(merged.collections.song, published.collections.song);
    assert.deepEqual(merged.collections.asmr, published.collections.asmr);
    assert.deepEqual(merged.collections.aegyo, seed.collections.aegyo);
    assert.equal(merged.updatedAt, published.updatedAt);
    const fallback = await synchronize({ previous: merged, retryOptions, fetchImpl: async () => { throw new Error('offline'); } });
    assert.deepEqual(fallback.manifest, merged);
    const malformed = structuredClone(published);
    malformed.collections.song = null;
    assert.throws(() => validateManifest(malformed, { allowMissing: true }), /song/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('karume-catalog-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
