
class EnrichedCommit {
  constructor(hash, branch, date, comment) {
    this.hash    = hash;
    this.branch  = branch;
    this.date    = date ?? '';
    this.comment = comment ?? '';
    const short  = CommitHelp.ShortHash(hash);
    if (branch && date) {
      this.label = `[${date}] ${short} — ${branch}`;
    } else if (branch) {
      this.label = `${short} — ${branch}`;
    } else {
      this.label = date ? `[${date}] ${short}` : short;
    }
  }
}
class CommitHelp {
  /**
   * Enrich a list of commit ids to a list of enriched commits
   * @param {string[]} commits
   * @param {object|null} gitHistory
   * @returns {EnrichedCommit[]}
   */
  static Enrich(commits, gitHistory) {
    // Build flat lookup: short id → entry (merge commits + PR arrays)
    const allGitEntries = [
      ...(gitHistory?.commits ?? []),
      ...(gitHistory?.branches ?? []),
      ...(gitHistory?.PR ?? [])
    ];

    const gitEntriesById = new Map(allGitEntries.map(e => [this.ShortHash(e.id), e]));
    // Enrich commits with git history data
    const enriched = commits.map(hash => {
      let short = this.ShortHash(hash);
      const entry = gitEntriesById.get(short);
      return new EnrichedCommit(hash, entry?.branch, entry?.date, entry?.comment)
    });

    // Sort by date descending (entries without date go last)
    enriched.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return enriched;
  }

  static CompareHashes(a, b) {
    let minLength = Math.min(a.length, b.length);
    let short_a = a.slice(0, minLength);
    let short_b = b.slice(0, minLength);
    return short_a.localeCompare(short_b);
  }

  static ShortHash(hash) {
    return hash.slice(0, 8);
  }

  /**
   * Formats an epoch-millisecond timestamp using a pattern of YYYY/MM/DD/HH/mm/ss
   * tokens (UTC, to match the campaign picker). Returns '' for a non-finite input.
   */
  static FormatTimestamp(ms, pattern) {
    if (!Number.isFinite(Number(ms))) return '';
    const d  = new Date(Number(ms));
    const p2 = n => String(n).padStart(2, '0');
    const map = {
      YYYY: String(d.getUTCFullYear()),
      MM:   p2(d.getUTCMonth() + 1),
      DD:   p2(d.getUTCDate()),
      HH:   p2(d.getUTCHours()),
      mm:   p2(d.getUTCMinutes()),
      ss:   p2(d.getUTCSeconds()),
    };
    return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, t => map[t]);
  }

  /**
   * Short, human-readable label for a campaign run.
   * @param {{user,campaign,commit,timestamp,subject}} ref
   */
  static CampaignRunLabel(ref) {
    const date = ref.timestamp != null
      ? ` (${CommitHelp.FormatTimestamp(ref.timestamp, 'YYYY-MM-DD HH:mm')})`
      : '';
    const subj = ref.subject ? ` · ${ref.subject}` : '';
    return `${ref.user}/${ref.campaign} — ${CommitHelp.ShortHash(ref.commit)}${date}${subj}`;
  }

  /**
   * Index of a commit in the (newest→oldest) git-history `commits` list, matched
   * by short hash. Returns -1 if absent.
   * @param {Array<{id:string}>} commits
   * @param {string} id
   */
  static CommitsIndexOf(commits, id) {
    if (!Array.isArray(commits) || !id) return -1;
    const short = this.ShortHash(id);
    return commits.findIndex(e => this.ShortHash(e.id) === short);
  }

  /**
   * Index of the first (newest) entry on a given branch in the `commits` list.
   * Returns -1 if the branch is absent.
   * @param {Array<{id:string, branch:string}>} commits
   * @param {string} branchName
   */
  static FirstBranchIndex(commits, branchName) {
    if (!Array.isArray(commits)) return -1;
    return commits.findIndex(e => e.branch === branchName);
  }

  /**
   * Walks the `commits` list from `startIndex` toward older commits and returns
   * the **data-layer hash** of the first one that has a Perf run, looked up in
   * `perfByShort` (short hash → the exact commit hash the data backend uses).
   * Returning the data-layer form — not the git-history `id` — is important: the
   * timestamp/data lookups are keyed by the hashes from LoadCommits, which can be
   * a different length than the full git id. Returns null if `perfByShort` is
   * null/empty (the Perf list is unavailable — better to report "no compare
   * target" than hand back a git hash the data backend can't resolve), if
   * `startIndex` is out of range, or if no commit at/after it has a Perf run.
   * @param {Array<{id:string}>} commits
   * @param {number} startIndex
   * @param {Map<string,string>|null} perfByShort - short hash → Perf commit hash
   */
  static NextPerfId(commits, startIndex, perfByShort) {
    if (!Array.isArray(commits) || startIndex < 0 || startIndex >= commits.length) return null;
    if (!perfByShort || perfByShort.size === 0) return null;
    for (let i = startIndex; i < commits.length; i++) {
      const hash = perfByShort.get(this.ShortHash(commits[i].id));
      if (hash) return hash;
    }
    return null;
  }
}

export { CommitHelp };