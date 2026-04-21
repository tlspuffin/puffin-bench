#! /bin/bash
output="$1"
[ -z "${output}" ] && {
  echo "Missing output argument";
  exit 1;
}
shift;

commit_folder=$1;
if [ "${commit_folder}" != "--no-standalone" ]; then
  [ -z "${commit_folder}" ] && {
    echo "Missing commit folder argument";
    exit 1;
  }
  [ ! -d "${commit_folder}" ] || [ ! -r "${commit_folder}" ] && { 
    echo "Directory ${commit_folder} is not readable"; 
    exit 1; 
  }
fi
shift

remove_repo=0;
repo_directory=$1;
if [ -z "${repo_directory}" ]; then
  repo_directory="$(mktemp -d)"
  remove_repo=1;
else 
  [ -d "${repo_directory}" ] || { echo "${repo_directory} is not a directory"; exit 1; }
  [ -r "${repo_directory}" ] || { echo "${repo_directory} is not readable"; exit 1; }
  [ ! -z "$(ls -A "${repo_directory}")" ] && { 
    git -C "${repo_directory}" rev-parse --git-dir >/dev/null 2>&1 || { echo "${repo_directory} is not a git folder"; exit 1; }
  }
fi
shift;

info="$(mktemp)"
infoMain="$(mktemp)"
git -C "${repo_directory}" fetch --all 2>/dev/null || git clone --filter=blob:none https://github.com/tlspuffin/tlspuffin.git "${repo_directory}"
#git -C "${repo_directory}" checkout dev
echo '{"commits": [' > "${output}.tmp"
git -C "${repo_directory}" log origin/dev --first-parent --oneline --pretty=format:"%H§%ad§%s§%P" --date=short ^origin/main | sed 's/"/\\"/g'  | awk -v gwd="$repo_directory" 'BEGIN{FS="§";PREV=""} {alias=""; if (NF == 4) { n=split($4, p, " "); if (n >=2) { cmd="git -C "gwd" diff --quiet "$1" "p[2]; if (system(cmd) == 0) { alias=p[2] } } } printf(" {\"id\":\"%s\",\"date\":\"%s\",\"comment\":\"%s\", \"alias\": \"%s\", \"branch\":\"dev\"},\n", $1, $2, $3, alias);}' >> "${output}.tmp"
git -C "${repo_directory}" log origin/main --first-parent --oneline --pretty=format:"%H§%ad§%s§%P" --date=short 3bc37034a^...0b44eed3b | sed 's/"/\\"/g'  | awk -v gwd="$repo_directory" 'BEGIN{FS="§";PREV=""} {alias=""; if (NF == 4) { n=split($4, p, " "); if (n >=2) { cmd="git -C "gwd" diff --quiet "$1" "p[2]; if (system(cmd) == 0) { alias=p[2] } } } printf(" {\"id\":\"%s\",\"date\":\"%s\",\"comment\":\"%s\", \"alias\": \"%s\", \"branch\":\"main\"},\n", $1, $2, $3, alias);}' | head -c -2 >> "${output}.tmp"
echo -e '],\n "standalone": [],\n "branches": []}' >> "${output}.tmp"
mv "${output}.tmp" "${output}"

tmp_json="$(mktemp)"
tmp="$(mktemp)"
cp "${output}" "${tmp_json}"
if [ "${commit_folder}" != "--no-standalone" ] && [ ! -z "$(ls -A "${commit_folder}")" ]; then
  for path in "${commit_folder}"/*; do
    commit="$(basename "$path")"

    branch=$(git -C "${repo_directory}" merge-base --is-ancestor "$commit" origin/main  && echo main  || echo "")
    [ -z "$branch" ] && branch="dev"
    baseID=$(git -C "${repo_directory}" merge-base "$commit" "origin/${branch}")
    [ ! -z "${baseID}" ] && baseID=$(git -C "$repo_directory" rev-parse "${baseID}")
    infos=$(git -C "${repo_directory}" show -s --format='%cs %s' "${commit}")
    infoDate=$(echo "${infos}" | sed 's/^\([^ ]*\) .*/\1/')
    infoComments=$(echo "${infos}" | sed 's/^[^ ]* \(.*\)/\1/')

    jq --arg id "$commit" --arg date "$infoDate" --arg comment "$infoComments" --arg base "$baseID" \
        ' .standalone = (.standalone // []) |
        .standalone += [{id:$id, date:$date, comment:$comment, base:$base}]
    ' "${tmp_json}" > "${tmp}" && mv "${tmp}" "${tmp_json}"
  done
fi

# Populate branches section - branches not merged into main or dev
while read -r branch_ref; do
  git -C "${repo_directory}" merge-base --is-ancestor "$branch_ref" origin/main 2>/dev/null && continue
  git -C "${repo_directory}" merge-base --is-ancestor "$branch_ref" origin/dev  2>/dev/null && continue

  branch_name=$(echo "$branch_ref" | sed 's|origin/||')
  commit=$(git -C "${repo_directory}" rev-parse "$branch_ref")
  infos=$(git -C "${repo_directory}" show -s --format='%cs %s' "$branch_ref")
  date=$(echo "$infos" | sed 's/^\([^ ]*\) .*/\1/')
  comment=$(echo "$infos" | sed 's/^[^ ]* \(.*\)/\1/' | sed 's/"/\\"/g')
  baseID=$(git -C "${repo_directory}" merge-base "$branch_ref" origin/dev 2>/dev/null \
           || git -C "${repo_directory}" merge-base "$branch_ref" origin/main 2>/dev/null || echo "")
  [ -n "$baseID" ] && baseID=$(git -C "${repo_directory}" rev-parse "$baseID")

  jq --arg branch "$branch_name" --arg id "$commit" \
     --arg date "$date" --arg comment "$comment" --arg base "$baseID" \
    '.branches += [{branch: $branch, id: $id, date: $date, comment: $comment, base: $base}]' \
    "${tmp_json}" > "${tmp}" && mv "${tmp}" "${tmp_json}"
done < <(git -C "${repo_directory}" for-each-ref --format='%(refname:short)' 'refs/remotes/origin/*' \
         | grep -v 'origin/HEAD\|origin/main\|origin/dev')

mv "${tmp_json}" "${output}"

(( remove_repo == 1)) && rm -rf "${repo_directory}"

exit 0
