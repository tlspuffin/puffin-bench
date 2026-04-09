
/**
 *
 * @param hash
 * @param branch
 * @param date
 * @constructor
 */
function EnrichedCommit(hash, branch, date) {
  this.hash = hash;
  this.branch = branch;
  this.date = date ?? '';
  const short = CommitHelp.ShortHash(hash);
  if (branch && date) {
    this.label = `[${date}] ${short} — ${branch}`
  } else if (branch) {
    this.label = `${short} — ${branch}`
  } else {
    this.label = date ? `[${date}] ${short}` : short;
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
      ...(gitHistory?.PR ?? [])
    ];

    const gitEntriesById = new Map(allGitEntries.map(e => [this.ShortHash(e.id), e]));
    // Enrich commits with git history data
    const enriched = commits.map(hash => {
      let short = this.ShortHash(hash);
      const entry = gitEntriesById.get(short);
      return new EnrichedCommit(hash, entry?.branch, entry?.date)
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
}

export { CommitHelp };