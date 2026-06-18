
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
}

export { CommitHelp };