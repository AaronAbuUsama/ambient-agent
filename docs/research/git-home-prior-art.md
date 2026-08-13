# Prior art for git-backed home directories

Research for the home-litigation map (#1), decision ticket #19. Question:
should `~/.ambient/` be a git repository — and if so, what should the
implementation copy or deliberately break from tools that already version a
home directory? Motivation: audit-log-for-free (every mandate edit a commit,
with attribution and rollback, for files an autonomous Root will author).
Wrinkle: `chats/<slug>/chat.yaml` binds slugs to real WhatsApp chat ids
(phone numbers), so history itself could be the leak.

Sources: chezmoi official docs (chezmoi.io); yadm official docs (yadm.io);
the original bare-repo dotfiles description (StreakyCobra on Hacker News,
popularized by the Atlassian tutorial); git-annex assistant docs and man
pages; the Obsidian Git plugin docs; etckeeper (Debian man page and
distribution docs); sqlite.org on WAL and corruption. Evidence with links
follows the synthesis.

## Answer first

**Yes, with the yadm/bare-repo shape, not the chezmoi shape, and no remote
by default.** The home is the worktree; the repo versions the authored plane
in place; `state/` is fenced by one ignore line. chezmoi's source/target
indirection exists to solve multi-machine templating — a problem Ambient
does not have — and its secrets machinery exists to make a _public_ repo
safe, a goal Ambient should simply not adopt.

**Copy:**

1. **The home-as-worktree model** (yadm, bare-repo pattern): version files
   where they live, no symlinks, no source directory to keep in sync.
   Ambient owns both the writer and the layout, so the indirection chezmoi
   adds buys nothing.
2. **Curated inclusion via one fence, not enumeration.** The bare-repo
   pattern inverts the ignore problem with `status.showUntrackedFiles no` —
   nothing is tracked unless added. Ambient gets the same property more
   simply: the ADR's plane rule means a two-line `.gitignore` (`state/`,
   `chats/*/wiki/`) makes everything else trackable by construction. No
   enumeration, ever.
3. **Commit as a side effect of the tool's own mutation path** (chezmoi
   `autoCommit`): chezmoi commits when _chezmoi_ changes the source
   directory — the writer commits, it does not watch itself. Ambient's Root
   writes go through Ambient code; that code should commit with the Root's
   identity. This, not a watcher, is what buys attribution.
4. **Bracketing, from etckeeper**: commit pre-existing drift _before_ a
   machine actor writes (apt's `DPkg::Pre-Install-Pkgs` hook), then commit
   the actor's own change after (`DPkg::Post-Invoke`). Any dirt found
   before a Root write is, by the ADR's ownership rule, a human edit —
   sweep-commit it as operator-authored first, so the Root's commit
   contains only the Root's change.
5. **Quiescence before adding** (git-annex `annex.delayadd`, Obsidian Git
   "auto commit-and-sync after stopping file edits"): never commit a file
   that may still be mid-write; debounce the sweep.
6. **Structured, cheap commit messages** (Obsidian Git `{{date}}`,
   `{{hostname}}`, `{{numFiles}}`, `{{files}}`; etckeeper's
   operation-derived messages): subject = actor + operation
   (`root: revise mandate for chats/team-x`), trailers for machine data
   (run id). Do not attempt model-written summaries in the hot path.

**Break / refuse:**

1. **No remote by default.** chezmoi's own docs warn that `autoPush` will
   publish an accidentally-added secret; yadm recommends a private repo
   _"even though they are encrypted."_ The audit motivation needs history,
   not replication. Adding a remote is a separate, explicit decision.
2. **No encryption layer** (yadm `encrypt` archive, chezmoi `encrypted_`
   age/gpg). Both designs keep plaintext in the home and ciphertext in the
   repo — they protect the _remote copy_ only. With no remote there is
   nothing to protect, and the cost is real: encrypted blobs have opaque
   diffs and cannot merge, destroying audit value for exactly the files
   that matter (`chat.yaml`, `mandate.yaml`).
3. **No secrets-in-repo problem at all.** chezmoi's password-manager
   templating exists so secrets never enter the source state. Ambient's
   ADR already does this structurally: `config.yaml` holds credential _env
   refs_, never values. Keep that invariant; it is the whole secrets story.
4. **No continuous-sync daemon as authority.** chezmoi explicitly refuses
   continuous operation; git-annex's assistant shows what unattended sync
   costs (arbitrary "update" messages, `.variant-XXX` conflict renames).
   The watcher is a wake-up hint; the commit points are the mutation path
   and the bracket.
5. **Never track `state/`.** SQLite in WAL mode is not merely awkward in
   git — the `.db` file alone is not even a consistent snapshot (evidence
   below). The one gitignore line is load-bearing; write it at init.

**Privacy verdict:** a local-only repo does not create a new leak — it makes
the existing plaintext-on-disk exposure _permanent_. `chat.yaml` already
holds chat ids in plaintext; `.git/` adds every historical version on the
same disk, under the same threat model. The risk phase-change is the remote,
not the repo. And history is effectively irreversible: removing a file from
history means `git filter-repo`/BFG rewriting every commit — so tracking
`chat.yaml` is a decision to keep chat ids forever. Make it consciously;
with no remote, it is the same decision already made by writing the file.

**Audit verdict:** git delivers the audit log _only if the writer commits_.
A sweep daemon that commits whatever changed can never attribute — every
commit carries the daemon's identity, and human and Root edits between
sweeps collapse into one blob. The fix falls out of the ADR: the runtime
commits its own policy writes at write time (author `Ambient Root`), so any
diff the bracket-sweep finds is by definition operator territory (author =
operator). Git's native author/committer split carries this: author = who
made the edit, committer = the runtime that recorded it. Rollback is
`git revert` (a new commit), never `reset` on the live home.

## Evidence

### chezmoi

Docs: [daily operations](https://www.chezmoi.io/user-guide/daily-operations/),
[source state attributes](https://www.chezmoi.io/reference/source-state-attributes/),
[.chezmoiignore](https://www.chezmoi.io/reference/special-files/chezmoiignore/),
[encryption](https://www.chezmoi.io/user-guide/encryption/),
[password managers](https://www.chezmoi.io/user-guide/password-managers/),
[design FAQ](https://www.chezmoi.io/user-guide/frequently-asked-questions/design/).

- **Source-state model.** chezmoi does not version the home directly: a
  separate source directory (itself the git repo) holds a declarative
  source state, and `chezmoi apply` computes and writes the target state
  into the home. Metadata is encoded in source _filenames_: "Some state is
  encoded in the source file names" — `private_` removes "all group and
  world permissions from the target file", `encrypted_` marks a file
  encrypted in the source state, `dot_foo` becomes `.foo`, `exact_`
  directories "remove anything not managed by chezmoi", `.tmpl` enables
  templating.
- **`.chezmoiignore`** lists target-side patterns to exclude, "interpreted
  as a template, whether or not it has a `.tmpl` extension. This allows
  different files to be ignored on different machines." Its job is
  machine-conditional _apply_ filtering — a multi-machine feature, not a
  privacy fence.
- **Secrets.** Two mechanisms, both aimed at making a public repo safe:
  encryption ("Encrypted files are stored in ASCII-armored format in the
  source directory with the `encrypted_` attribute", age/gpg/git-crypt/
  transcrypt; `chezmoi edit` "will transparently decrypt the file before
  editing and re-encrypt it afterwards") and password-manager template
  functions (1Password, Bitwarden, Vault, …) that fetch values at apply
  time: "Using a password manager with chezmoi enables you to maintain a
  public dotfiles repository while keeping your secrets secure." Plaintext
  lives only in the target home.
- **Auto-commit.** `[git] autoCommit` / `autoPush`: "Whenever a change is
  made to your source directory, chezmoi will commit the changes with an
  automatically-generated commit message (if `autoCommit` is true) and push
  them to your repo (if `autoPush` is true)." `autoPush` implies
  `autoCommit`. Messages are generated from the files changed and
  customizable via `git.commitMessageTemplate` /
  `git.commitMessageTemplateFile`. The docs warn: "Be careful when using
  `autoPush`. If your dotfiles repo is public and you accidentally add a
  secret in plain text, that secret will be pushed to your public repo."
  Note the trigger: a chezmoi _command_ modifying the source directory —
  commit-as-side-effect-of-mutation, not a filesystem watcher.
- **Refusals.** chezmoi applies on demand, not continuously ("run `chezmoi
apply` if you're happy with them"); it takes "the opinionated choice to
  use a single source of truth, i.e. a single branch in a single git repo";
  it "is designed to operate on your home directory, and is explicitly not
  a full system configuration management tool" — managing files outside the
  home is "extremely strongly discouraged." It manages the files you add,
  never the whole home.

### yadm

Docs: [overview](https://yadm.io/docs/overview),
[encryption](https://yadm.io/docs/encryption),
[alternates](https://yadm.io/docs/alternates),
[FAQ](https://yadm.io/docs/faq).

- **Model.** "yadm is like having a version of Git, that only operates on
  your dotfiles." The repo is stored out of the way (the FAQ references
  `$HOME/.local/share/yadm/repo.git/info/exclude`, i.e. a bare repo under
  `~/.local/share/yadm/`) with `$HOME` as the worktree — "You don't have to
  move your dotfiles, or have them symlinked from another location." "yadm
  automatically inherits all of Git's features, allowing you to branch,
  merge, rebase, use submodules, etc."
- **Untracked noise.** "By default, yadm is configured to ignore untracked
  files when displaying a status" (`status.showUntrackedFiles no`;
  overridable with `yadm status -unormal` or
  `yadm gitconfig --unset status.showUntrackedFiles`). Machine state stays
  out simply by never being added — inclusion is curated, not filtered.
- **Encryption.** `$HOME/.config/yadm/encrypt` holds patterns (e.g.
  `.ssh/*.key`); `yadm encrypt` "will find all files matching the patterns,
  and prompt for a password", producing `$HOME/.local/share/yadm/archive`.
  "The patterns and `archive` should be added to the yadm repository so
  they are available across multiple systems" — ciphertext is tracked, the
  plaintext files themselves are not. GPG by default, asymmetric via
  `yadm.gpg-recipient`. And the honest caveat: "It is recommended that you
  use a private repository when keeping confidential files, even though
  they are encrypted."
- **Alternates.** Multi-machine variance via filename suffixes: "yadm will
  automatically create a symbolic link to the appropriate version of a
  file, when a valid suffix is appended to the filename"
  (`##os.Darwin,hostname.host2`, negation `~os.Darwin`, scored by
  specificity). Solves per-machine divergence inside one repo — a feature
  Ambient (one home, one machine) does not need.

### The plain bare-repo pattern

Sources: the original description,
[StreakyCobra on Hacker News](https://news.ycombinator.com/item?id=11070797)
(retrieved via the Algolia HN API);
[Atlassian's tutorial write-up](https://www.atlassian.com/git/tutorials/dotfiles).

- The whole technique is three lines: `git init --bare $HOME/.myconf`;
  `alias config='/usr/bin/git --git-dir=$HOME/.myconf/ --work-tree=$HOME'`;
  `config config status.showUntrackedFiles no`.
- `showUntrackedFiles no` is the load-bearing line: with `$HOME` as
  worktree, `git status` would otherwise list the entire home as untracked.
  Hiding untracked files **inverts the ignore problem** — instead of
  enumerating what to exclude (hopeless in a home directory), nothing is
  versioned until explicitly `config add`-ed. Tracking is opt-in; the
  ignore file is unnecessary.
- Ambient's ADR makes even this unnecessary: because every machine file
  lands under `state/` by rule, a normal (non-bare) repo at `~/.ambient/`
  with `state/` ignored has a clean status by construction — curated
  inclusion achieved with normal git semantics, so `git status` stays a
  meaningful "what changed in the policy plane" view.

### Auto-committers: chezmoi, git-annex assistant, Obsidian Git, etckeeper

Sources: chezmoi daily-operations (above);
[git-annex assistant](https://git-annex.branchable.com/assistant/),
[git-annex man page](https://git-annex.branchable.com/git-annex/),
[automatic conflict resolution](https://git-annex.branchable.com/automatic_conflict_resolution/);
[Obsidian Git docs](https://publish.obsidian.md/git-doc/Features) and
[repo](https://github.com/Vinzent03/obsidian-git);
[etckeeper man page](https://manpages.debian.org/testing/etckeeper/etckeeper.8.en.html),
[Ubuntu etckeeper docs](https://ubuntu.com/server/docs/how-to/backups/install-etckeeper/).

- **Trigger models observed.** Four distinct ones: (1) chezmoi — commit as
  a side effect of the tool's own mutating command; (2) git-annex
  assistant — filesystem watcher, "watches for changes to files in the
  current directory and its subdirectories, and automatically syncs them";
  (3) Obsidian Git — timers: "a basic interval to run commit-and-sync
  every X minutes" or debounced "auto commit-and-sync after stopping file
  edits… waits X minutes after your latest change"; (4) etckeeper —
  operation bracketing plus a daily catch-all: hooks "called by apt's
  DPkg::Pre-Install-Pkgs hook" and "by apt's DPkg::Post-Invoke hook", and
  a cron/systemd timer that commits leftover drift with the message
  "daily autocommit" (disable via `AVOID_DAILY_AUTOCOMMITS`).
- **Debounce / mid-write safety.** git-annex `annex.delayadd`: "Makes the
  watch and assistant commands delay for the specified number of seconds
  before adding a newly created file to the annex. Normally this is not
  needed, because they already wait for all writers of the file to close
  it." Watcher-based committers must solve quiescence; mutation-path
  committers get it for free (the writer knows when it is done).
- **Message conventions.** Watcher-based tools produce low-information
  messages: git-annex "usually makes up its own commit message (eg
  'update'), since users rarely look at or care about changes to that
  branch" (customizable via `annex.commitmessage`). Obsidian Git does
  better with templates and placeholders — `{{date}}`, `{{hostname}}`,
  `{{numFiles}}`, `{{files}}` (e.g. "vault backup: {{date}}"). etckeeper
  derives messages from the operation that caused the change. Lesson: the
  message is only as informative as what the committer _knows_; only the
  writer knows the intent.
- **Conflict story.** Only relevant once a second replica exists.
  git-annex auto-resolves rather than blocking: "the file that has the
  merge conflict will be renamed, with '.variant-XXX' tacked onto it",
  deterministically ("the MD5 checksum of the key") so that "if two or
  more repositories both get a merge conflict, and resolve it, the
  resolved repositories will not themselves conflict" — and a human still
  has to clean up the variants afterwards. Obsidian Git surfaces conflicts
  to the user interactively, which does not exist for an unattended
  daemon. Lesson: an unattended home must never be in a position to merge
  — single writer per file class, and any future remote is push-only.
- **Metadata.** etckeeper's pre-commit hook "stores metadata" (ownership
  and permissions git does not track) — relevant to /etc, mostly moot for
  Ambient's per-user home.

### SQLite and binary files in git

Sources: [WAL mode](https://sqlite.org/wal.html),
[How to corrupt an SQLite database](https://sqlite.org/howtocorrupt.html),
[backup API](https://sqlite.org/backup.html),
[gitattributes](https://git-scm.com/docs/gitattributes).

- **A live WAL-mode db is not a copyable file.** In WAL mode "the original
  content is preserved in the database file and the changes are appended
  into a separate WAL file. A COMMIT occurs when a special record
  indicating a commit is appended to the WAL" — committed transactions
  live in `ambient.db-wal` until a checkpoint ("moving the WAL file
  transactions back into the database is called a checkpoint"). Therefore:
  "If a database file is separated from its WAL file, then transactions
  that were previously committed to the database might be lost, or the
  database file might become corrupted." A git commit of `ambient.db`
  alone is precisely that separation.
- **Even snapshotting all three files while live is unsafe.** "Systems
  that run automatic backups in the background might try to make a backup
  copy of an SQLite database file while it is in the middle of a
  transaction. The backup copy then might contain some old and some new
  content, and thus be corrupt." The sanctioned mechanisms are the backup
  API, `VACUUM INTO`, or `sqlite3_rsync` — never a file copy of a live db.
- **And git can do nothing with the blob anyway.** git's own `binary`
  attribute macro (gitattributes) expands to `-diff -merge -text`: no
  readable diff, no merge — each version is an opaque full blob. The
  ecosystem consensus follows: text dumps (`sqlite3 .dump`) if history of
  _content_ is wanted, git-annex/LFS if mere storage is wanted, and never
  the live file. For Ambient neither applies: `state/` is machine truth
  with its own durability story; it stays out of the repo, full stop.

## Synthesis for Ambient

### What remains risky once `state/` is fenced

The gitignore line solves the _committability_ problem (WAL, locks,
mirror). What it does not solve:

1. **`chats/<slug>/chat.yaml`** — the binding file is the one place a raw
   chat id (phone number) must exist in the policy plane, by ADR design.
   Every commit touching it embeds the id in history permanently.
2. **`mandate.yaml` prose** — an LLM author writes mandates about real
   people; names, numbers, and situational detail will appear in prose no
   redaction rule can reliably police. History keeps every revision,
   including ones later toned down.
3. **Deleted-but-in-history** — deleting a chat folder removes it from the
   worktree, not from `.git/`. Excising it later requires
   `git filter-repo`/BFG history rewriting. Treat history as append-only
   and permanent.

### Options for the history risk

| Option                                                   | What it looks like                                                                               | Honest trade-off                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — repo, no remote                                      | `git init` at init time; `.gitignore` = `state/` (+ `chats/*/wiki/`); nothing leaves the machine | Leak surface unchanged from today (disk access gets plaintext either way; history adds only old revisions on the same disk). No off-machine copy — the backup story stays whatever it is for the home as a whole (a home backup naturally includes `.git/`).          |
| B — private remote                                       | A + push to GitHub/self-hosted private repo                                                      | Off-machine replica of chat ids and mandate prose; provider trust becomes part of the privacy boundary. Both chezmoi (autoPush warning) and yadm (private-repo advice) treat this as the dangerous step. Buys off-machine recovery.                                   |
| C — encrypted tracked files (yadm archive / chezmoi age) | ciphertext of `chat.yaml` (or all of `chats/`) committed; plaintext gitignored                   | Protects only a remote copy — locally the plaintext must exist for the runtime. Diffs and merges of the protected files become opaque blobs, which deletes the audit log exactly where it matters. Only worth revisiting _if_ B is ever chosen.                       |
| D — redaction discipline                                 | never track `chat.yaml`; slugs only in git                                                       | History free of ids — but the audit log has a hole at identity writes, rollback cannot restore a binding, and mandate prose still leaks people-details anyway, so the history is not actually clean. Enforcing prose redaction against an LLM author is not credible. |

**Recommendation: A.** The repo's job is audit and rollback, not sync. A
delivers both with zero new privacy exposure and one init-time gitignore.
B is a separate future decision with its own ticket-worthy trade-off; C
only makes sense downstream of B; D sacrifices the motivating feature for a
privacy gain it cannot actually deliver (the prose leaks regardless).

### The auto-commit design prior art supports

- **Primary path — the writer commits.** Every runtime policy write
  (mandate revision, skill authoring, mcp.json grant, chat folder
  creation) ends with a commit of exactly the files it wrote. chezmoi's
  trigger model, minus the push. Multi-file operations (chat.yaml +
  mandate.yaml at folder creation) are one commit — the operation, not the
  file, is the unit.
- **Bracket, don't tail.** Before the runtime writes, if the policy plane
  is dirty, first commit the drift as an operator edit (etckeeper's
  pre-install hook, transplanted). This isolates the Root's diff and
  attributes human edits without a daemon race.
- **Sweep as backstop, debounced.** A watcher (or the existing wake-hint
  machinery) may trigger the same drift-sweep between runtime writes, with
  git-annex-style quiescence (delay after last change; skip files still
  open). etckeeper's daily timer is the floor if no watcher exists.
- **When not to commit:** anything under `state/` or a derived `wiki/`
  (regenerable churn would drown the authored history — the repo is the
  authored plane only); mid-operation (commit only at operation end);
  files failing quiescence; and never auto-push (no remote exists in
  option A; if one ever does, push is explicit or push-only mirror, never
  pull — an unattended home must never merge).
- **Messages:** subject `actor: operation` in product language
  (`root: revise mandate for chats/team-x`,
  `operator: edit config.yaml (drift sweep)`), machine data as trailers
  (`Ambient-Run: <run-id>`). Obsidian-style placeholders, not model-written
  hot-path prose.

### Does git actually deliver the audit log?

Yes, with one condition prior art makes stark: **attribution exists only at
commit time, and only the writer knows who it was.** git natively separates
author (who made the change) from committer (who recorded it) — set
`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` per actor
([git-commit](https://git-scm.com/docs/git-commit)): author
`Ambient Root <root@ambient.invalid>` for runtime writes, author the
operator for drift sweeps, committer always the runtime. The ADR's plane
rule is what makes the operator attribution _sound_ rather than a guess:
outside `state/`, only humans and the Root write, and the Root always
commits its own writes — so unexplained dirt is human by elimination.
git-annex's "update" messages are the cautionary tale for skipping this:
a history exists, but it answers no questions. Rollback semantics for a
live home: `git revert` (new commit, runtime re-reads the file), never
`reset --hard` under a running watcher.

One thing git does not provide: tamper-evidence against a local attacker —
history can be rewritten by anyone with disk access. The audit log is for
_reconstruction and attribution of cooperative actors_ (Root vs operator),
not a security boundary. That is exactly what the motivation asked for.
