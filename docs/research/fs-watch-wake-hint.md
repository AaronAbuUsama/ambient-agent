# fs-watch as a wake hint for `~/.ambient` hot reload

Research for issue #13. Question: is Node's `fs.watch` reliable enough to be
the wake hint for hot policy reload of human-edited yaml/markdown in
`~/.ambient`, given that fs events are hints only — a slow poll and startup
reconciliation always remain the truth?

## Answer

**Yes — as a hint it is good, provided you watch directories, never files.**
On macOS (FSEvents) and Linux (inotify) a directory watch reliably fires
within ~10ms of every editor save pattern, including atomic-save inode swaps.
A watch on an individual _file_ silently dies the moment an editor does an
atomic save (verified empirically below), so per-file watching is the one
design that must be off the table. With the mitigations below, the hint
converts the reload latency floor from "poll interval" to "tens of
milliseconds" in the overwhelmingly common case, and the poll fallback only
has to cover watcher death, network filesystems, and Docker-style mounts.

### Mitigations (concrete)

| Mitigation                        | Value                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Watch the directory, not the file | `fs.watch(dir)` per dir of interest, or `fs.watch('~/.ambient', { recursive: true })` | File watches follow the inode and go permanently silent after an atomic save. Directory watches keep reporting because the _name_ reappears in the dir. Recursive is supported on macOS and Linux on this repo's Node (v24.19.0; Linux support landed in Node v19.1.0).                                                                                                                                            |
| Treat every event as one bit      | any `(eventType, filename)` → mark tree dirty, rescan by mtime/hash                   | `eventType` is unreliable (macOS reported `rename` for a plain in-place append) and `filename` may be `null` per the Node docs. Never dispatch on event semantics.                                                                                                                                                                                                                                                 |
| Debounce                          | ~200ms trailing debounce before rescan                                                | Duplicates are real: one `rename(2)` produced the same event twice in the same millisecond, and an editor save is a burst (tmp create + rename + metadata). All bursts observed fit inside ~1ms; 200ms absorbs multi-file saves ("save all") too, and is imperceptible for a human-edit reload path.                                                                                                               |
| Keep the slow poll as truth       | full rescan every 30–60s + on startup                                                 | Covers NFS/SMB, Docker/VM mounts (Node docs: watching "can be unreliable, and in some cases impossible" there), a deleted-and-recreated `~/.ambient` (the dir watch itself dies on inode swap of the _watched_ dir), and any missed event. Plain `setInterval` + stat-compare in the existing reconciliation path; `fs.watchFile` (stat-poll, default interval 5007ms/file) is not needed as a separate mechanism. |
| Recreate on error/close           | on `FSWatcher` `'error'`/`'close'`: rebuild watcher, force rescan                     | Watcher death must degrade to poll latency, not to never.                                                                                                                                                                                                                                                                                                                                                          |

## Evidence

### Node.js official docs (v24.x, matching this repo's Node v24.19.0)

Source: [fs.watch caveats](https://nodejs.org/docs/latest-v24.x/api/fs.html#caveats)
([availability](https://nodejs.org/docs/latest-v24.x/api/fs.html#availability),
[inodes](https://nodejs.org/docs/latest-v24.x/api/fs.html#inodes),
[filename argument](https://nodejs.org/docs/latest-v24.x/api/fs.html#filename-argument)),
[fs.watchFile](https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilefilename-options-listener).

- **Backends**: "On Linux systems, this uses `inotify(7)`. … On macOS, this
  uses `kqueue(2)` for files and `FSEvents` for directories."
- **The inode caveat (the atomic-save killer)**: "On Linux and macOS systems,
  `fs.watch()` resolves the path to an inode and watches the inode. If the
  watched path is deleted and recreated, it is assigned a new inode. The watch
  will emit an event for the delete but will continue watching the _original_
  inode. Events for the new inode will not be emitted. This is expected
  behavior."
- **Filename**: "Even on supported platforms, `filename` is not always
  guaranteed to be provided. … have some fallback logic if it is `null`."
- **Unavailability**: "watching files or directories can be unreliable, and in
  some cases impossible, on network file systems (NFS, SMB, etc) or host file
  systems when using virtualization software such as Vagrant or Docker."
- **Recursive**: option documented as "only on supported platforms"; the
  changelog entry on the same page records "Added recursive support for Linux,
  AIX and IBMi" in v19.1.0
  ([nodejs/node#45098](https://github.com/nodejs/node/pull/45098)). macOS and
  Windows were already supported. So on Node ≥ 20, recursive covers both
  deployment platforms.
- **fs.watchFile cost**: stat polling, default `interval: 5007` ms per file;
  "Using `fs.watch()` is more efficient than `fs.watchFile` … `fs.watch`
  should be used instead … when possible."

### libuv (the layer under fs.watch)

Source: [uv_fs_event docs](https://docs.libuv.org/en/v1.x/fs_event.html).

- Only two event kinds exist at this layer: `UV_RENAME` and `UV_CHANGE` —
  which is why Node's `eventType` carries so little information.
- `UV_FS_EVENT_RECURSIVE` is native "only on OSX and Windows"; Node's Linux
  recursive support (v19.1.0) is implemented above libuv on inotify, one watch
  per subdirectory. Practical Linux note: deep trees consume
  `fs.inotify.max_user_watches` entries; `~/.ambient` is small, so this is a
  non-issue there.
- "On macOS, events collected by the OS immediately before calling
  `uv_fs_event_start` might be reported" — confirmed empirically below;
  another reason a fresh watcher must be followed by a rescan rather than
  trusting its first events.
- Directory watches report "a relative path to a file contained in the
  directory, or NULL if the file name cannot be determined."

### What editors actually do on save (primary sources)

- **Vim** ([`'backupcopy'`](https://vimhelp.org/options.txt.html#'backupcopy')):
  default `auto` — "When Vim sees that renaming the file is possible without
  side effects … that is used", i.e. the original is renamed to the backup and
  a **new file (new inode)** is written at the path. The doc explicitly warns
  this breaks "several file-watcher daemons like inotify".
- **Helix** ([helix-view/src/editor.rs](https://github.com/helix-editor/helix/blob/master/helix-view/src/editor.rs)):
  `atomic_save` **defaults to `true`** — renames the original to a `.bck`
  tempfile and writes a new file. Its own doc comment: "may confuse some file
  watching/hot reloading programs."
- **VS Code** ([diskFileSystemProvider.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/diskFileSystemProvider.ts),
  [fileUserDataProvider.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/userData/common/fileUserDataProvider.ts)):
  ordinary workspace saves are in-place writes (no inode swap), but VS Code's
  own user-data writes go through `doWriteFileAtomic` with a `.vsctmp`
  temp-then-rename. So both patterns occur in the wild depending on which
  editor/path touched the file.

Conclusion: two of the three named editors swap the inode on **every default
save**. Per-file watching is guaranteed to go stale in normal use.

### chokidar (ecosystem evidence of the standard workarounds)

Source: [chokidar README](https://github.com/paulmillr/chokidar).

Chokidar exists because raw `fs.watch` events "are not reported twice" only
after its normalization, raw changes arrive "as add / change / unlink instead
of useless `rename`", and it needs explicit handling for "atomic writes" used
by editors (its `atomic` option folds the unlink+add of an atomic save into
one change event) plus `awaitWriteFinish` for chunked writes and `usePolling`
(`fs.watchFile`) as the network-filesystem fallback. Every one of these maps
onto a mitigation above; Ambient's dirty-flag + rescan design needs none of
chokidar's per-event fidelity, so the raw API suffices.

## Empirical check (this machine)

Throwaway probe: `fs.watch` on a temp dir, on the file directly, and
recursively, while performing an in-place append, an atomic save
(write `.tmp`, `rename(2)` over the target), a post-swap append, and a nested
write. Raw output, Node v24.19.0, macOS (Darwin 25.1.0):

```text
node v24.19.0 on darwin (25.1.0)
  +11ms [watch:dir] event=change filename=fswatch-probe-QSt8WJ
  +11ms [watch:dir] event=rename filename=policy.yaml
  +11ms [watch:dir] event=rename filename=nested
  +11ms [watch:dir-recursive] event=change filename=fswatch-probe-QSt8WJ
  +11ms [watch:dir-recursive] event=rename filename=policy.yaml
  +11ms [watch:dir-recursive] event=rename filename=nested
--- baseline (watchers started, nested/ created before recursive watcher) ---
  +303ms [watch:file] event=change filename=policy.yaml
  +314ms [watch:dir] event=rename filename=policy.yaml
  +314ms [watch:dir-recursive] event=rename filename=policy.yaml
--- after in-place append to policy.yaml ---
  +704ms [watch:file] event=rename filename=policy.yaml
  +717ms [watch:dir] event=rename filename=.policy.yaml.tmp
  +717ms [watch:dir] event=rename filename=policy.yaml
  +717ms [watch:dir] event=rename filename=policy.yaml
  +717ms [watch:dir-recursive] event=rename filename=.policy.yaml.tmp
  +717ms [watch:dir-recursive] event=rename filename=policy.yaml
  +717ms [watch:dir-recursive] event=rename filename=policy.yaml
--- after atomic save (write .tmp, rename over policy.yaml) ---
  +1120ms [watch:dir] event=rename filename=policy.yaml
  +1120ms [watch:dir-recursive] event=rename filename=policy.yaml
--- after append to post-rename file (did [watch:file] survive the inode swap?) ---
  +1522ms [watch:dir-recursive] event=rename filename=nested/deep.md
--- after write to nested/deep.md ---
```

Observations:

1. **The direct file watch died after the atomic save.** It fired one final
   `rename` at the swap, then saw _nothing_ for the subsequent append to the
   new inode. Both directory watchers kept reporting. This is the Node inode
   caveat, reproduced exactly.
2. **Duplicates are real**: a single `rename(2)` produced
   `rename policy.yaml` twice in the same millisecond on the dir watchers.
3. **`eventType` is meaningless on macOS dir watches**: a plain in-place
   append was reported as `rename`.
4. **Pre-start events leak in** (libuv macOS caveat): actions taken before the
   watchers were registered were delivered at +11ms after start.
5. **Latency is excellent**: every hint arrived ~10–15ms after the syscall.
6. **Recursive watch works on macOS** and reports subdir-relative paths
   (`nested/deep.md`); the non-recursive dir watch correctly saw nothing.

Not tested empirically here: Linux (this machine is macOS). Linux behavior is
taken from the Node docs and libuv docs above; the inode caveat is documented
identically for both platforms, so the same mitigations apply.
